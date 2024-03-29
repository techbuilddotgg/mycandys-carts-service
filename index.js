const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const productService = require('./productService');
const Cart = require('./cartModel');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
const axios = require('axios');
const uuid = require('uuid');
const { setupRabbitMQ, getRabbitMQChannel } = require('./rabbitmq/rabbitmq');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, { dbName: 'db_carts' });

// Set up RabbitMQ
setupRabbitMQ();

const { getProductDetails } = productService;

// Swagger options
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Cart API',
            version: '1.0.0',
            description: 'API documentation for managing user cart.',
        },
        externalDocs: {
            url: "/swagger.json"
        },
        servers: [
            {
                url: process.env.SWAGGER_URI,
            },
        ],
    },
    apis: ['index.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});
app.get('/v3/api-docs', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Middleware to verify the JWT token
const verifyToken = async (req, res, next) => {
    try {
        const response = await axios.get(`${process.env.AUTH_SERVICE_URL}/auth/verify`, {
            headers: {
                Authorization: req.headers.authorization,
                Host: req.headers.host,
            },
        });
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Middleware to log requests
app.use(async (req, res, next) => {
    next();

    const existingCorrelationId = req.headers['X-Correlation-Id'];

    const correlationId = existingCorrelationId || uuid.v4();
    req.headers['X-Correlation-Id'] = correlationId;

    // Call the '/stats' endpoint
    const calledService = `[${req.method}] - ${req.route.path}`;
    try {
        await axios.post(`${process.env.CARTS_ANALYTICS_SERVICE_URL}/stats`, { calledService });
        console.log(`Successfully called /stats for ${calledService}`);
    } catch (error) {
        console.log(`Error calling /stats for ${calledService}: ${error.message}`);
    }

    res.on('finish', () => {
        const { statusCode } = res;

        const logMessage = {
            timestamp: new Date().toISOString(),
            correlationId,
            url: req.protocol + '://' + req.get('host') + req.originalUrl,
            message: `${req.method} - ${req.url}`,
            service: 'cart',
            type: statusCode >= 500 ? 'Error' : (statusCode >= 400 ? 'Warning' : 'Info'),
        }

        const logMessageJson = JSON.stringify(logMessage);
        const rabbitMQChannel = getRabbitMQChannel();
        if (rabbitMQChannel) {
            rabbitMQChannel.publish(process.env.RABBITMQ_EXCHANGE, '', Buffer.from(logMessageJson));
            console.log('Log message sent to RabbitMQ:', logMessageJson);
        }
    });
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Check if the service is running.
 *     responses:
 *       200:
 *         description: Service is running.
 *       500:
 *         description: Service is not running.
 */
app.get('/health', (req, res) => {
    try {
        // You can add more sophisticated health-check logic here if needed
        res.status(200).json({ status: 'Service is running' });
    } catch (error) {
        res.status(500).json({ error: 'Service is not running' });
    }
});


// Get the items in the cart with product details
/**
 * @swagger
 * /carts/{cartId}:
 *   get:
 *     summary: Get the items in the cart with product details
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: ID of the user's cart
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Successful response with the user's cart
 *       '500':
 *         description: Internal Server Error
 */
app.get('/carts/:cartId', async (req, res) => {
    try {
        const { cartId } = req.params;
        const cart = await Cart.findOne({ _id: cartId });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        res.status(200).json(cart);
    } catch (error) {
        console.log(error)
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add a product to the cart
/**
 * @swagger
 * /carts/{cartId}/products/{productId}:
 *   post:
 *     summary: Add a product to the user's cart
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: ID of the user's cart
 *         schema:
 *           type: string
 *       - in: path
 *         name: productId
 *         required: true
 *         description: ID of the product to be added
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Successful response with the updated cart
 *       '404':
 *         description: Product not found
 *       '500':
 *         description: Internal Server Error
 */
app.post('/carts/:cartId/products/:productId', async (req, res) => {
    try {
        const { cartId, productId } = req.params;
        let cart = await Cart.findOne({ _id: cartId });

        // If the user doesn't have a cart, create a new one
        if (!cart) {
            const newCart = new Cart({ items: [], fullPrice: 0 });
            await newCart.save();
            // Assign the newly created cart to the 'cart' variable
            cart = newCart;
        }

        // Fetch product details from the products microservice
        const product = await getProductDetails(productId);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const existingItem = cart.items.find(item => item.productId === productId);
        let price;

        if (existingItem) {
            existingItem.quantity += 1;
            cart.fullPrice += existingItem.price;
            cart.fullPrice = parseFloat(cart.fullPrice.toFixed(2));
        } else {
            // Calculate the price based on the presence of discount
            price = product.temporaryPrice !== -1 ? product.temporaryPrice : product.originalPrice;
            cart.items.push({
                productId: product._id,
                name: product.name,
                price: price, // Use temporaryPrice if not -1, otherwise use originalPrice
                imgUrl: product.imgUrl,
                quantity: 1,
            });
        }

        // Update the fullPrice of the cart based on the added item
        cart.fullPrice += price;
        cart.fullPrice = parseFloat(cart.fullPrice.toFixed(2));

        await cart.save();
        res.status(200).json(cart);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update the quantity of a product in the cart
/**
 * @swagger
 * /carts/{cartId}/products/{productId}:
 *   put:
 *     summary: Update the quantity of a product in the cart.
 *     consumes:
 *       - application/json
 *     produces:
 *       - application/json
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: The ID of the user's cart.
 *         schema:
 *           type: string
 *       - in: path
 *         name: productId
 *         required: true
 *         description: The ID of the product to update in the cart.
 *         schema:
 *           type: string
 *       - in: body
 *         name: quantity
 *         required: true
 *         description: The new quantity of the product in the cart.
 *         schema:
 *           type: object
 *           properties:
 *             quantity:
 *               type: integer
 *     responses:
 *       200:
 *         description: Successful update. Returns the updated cart.
 *       404:
 *         description: Cart, product, or product in the cart not found.
 *       500:
 *         description: Internal Server Error.
 */
app.put('/carts/:cartId/products/:productId', async (req, res) => {
    try {
        const { cartId, productId } = req.params;
        const { quantity } = req.body;
        const cart = await Cart.findOne({ _id: cartId });

        if(quantity < 1) {
            return res.status(400).json({ error: 'Quantity cannot be less than 1' });
        }

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        // Fetch product details from the products microservice
        const product = await getProductDetails(productId);

        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const existingItem = cart.items.find(item => item.productId === productId);

        if (existingItem) {
            // Update fullPrice based on the change in quantity
            cart.fullPrice += (quantity - existingItem.quantity) * existingItem.price;
            cart.fullPrice = parseFloat(cart.fullPrice.toFixed(2));
            existingItem.quantity = quantity;
            await cart.save();
            res.status(200).json(cart);
        } else {
            res.status(404).json({ error: 'Product not found in the cart' });
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a product from the user's cart completely
/**
 * @swagger
 * /carts/{cartId}/delete/products/{productId}:
 *   put:
 *     summary: Remove a product from the user's cart completely
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: ID of the user's cart
 *         schema:
 *           type: string
 *       - in: path
 *         name: productId
 *         required: true
 *         description: ID of the product to be removed
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Successful response with the updated cart
 *       '404':
 *         description: Product not found in the cart
 *       '500':
 *         description: Internal Server Error
 */
app.put('/carts/:cartId/delete/products/:productId', async (req, res) => {
    try {
        const { cartId, productId } = req.params;
        const cart = await Cart.findOne({  _id: cartId  });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        // Fetch product details from the products microservice
        const product = await getProductDetails(productId);

        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Update fullPrice based on the removed item
        const removedItem = cart.items.find(item => item.productId === productId);
        if (removedItem) {
            cart.fullPrice -= removedItem.quantity * removedItem.price;
            cart.fullPrice = parseFloat(cart.fullPrice.toFixed(2));
        }

        cart.items = cart.items.filter(item => item.productId !== productId);
        await cart.save();
        res.status(200).json(cart);
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Decrease the quantity of a product in the cart
/**
 * @swagger
 * /carts/{cartId}/remove/products/{productId}:
 *   put:
 *     summary: Decrease the quantity of a product in the cart
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: ID of the user's cart
 *         schema:
 *           type: string
 *       - in: path
 *         name: productId
 *         required: true
 *         description: ID of the product to decrease the quantity
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Successful response with the updated cart
 *       '404':
 *         description: Product not found in the cart
 *       '500':
 *         description: Internal Server Error
 */
app.put('/carts/:cartId/remove/products/:productId', async (req, res) => {
    try {
        const { cartId, productId } = req.params;
        const cart = await Cart.findOne({  _id: cartId  });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        // Fetch product details from the products microservice
        const product = await getProductDetails(productId);

        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const existingItem = cart.items.find(item => item.productId === productId);

        if (existingItem) {
            if (existingItem.quantity > 1) {
                existingItem.quantity -= 1;
                // Update fullPrice based on the decreased quantity
                cart.fullPrice -= existingItem.price;
                cart.fullPrice = parseFloat(cart.fullPrice.toFixed(2));
                await cart.save();
                res.status(200).json(cart);
            } else {
                // If quantity is 1, remove the product from the cart
                // Update fullPrice based on the removed item
                cart.fullPrice -= existingItem.price;
                cart.fullPrice = parseFloat(cart.fullPrice.toFixed(2));
                cart.items = cart.items.filter(item => item.productId !== productId);
                await cart.save();
                res.status(200).json(cart);
            }
        } else {
            res.status(404).json({ error: 'Product not found in the cart' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Clear all items from the user's cart
/**
 * @swagger
 * /carts/{cartId}/clear:
 *   put:
 *     summary: Clear all items from the user's cart
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: ID of the user's cart
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Successful response with the cleared cart
 *       '404':
 *         description: Cart not found
 *       '500':
 *         description: Internal Server Error
 */
app.put('/carts/:cartId/clear', async (req, res) => {
    try {
        const { cartId } = req.params;
        const cart = await Cart.findOne({  _id: cartId  });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        // Update fullPrice based on the cleared items
        cart.fullPrice = 0;

        cart.items = [];
        await cart.save();
        res.status(200).json(cart);
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete the entire shopping cart
/**
 * @swagger
 * /carts/{cartId}:
 *   delete:
 *     summary: Delete the entire shopping cart.
 *     parameters:
 *       - in: path
 *         name: cartId
 *         required: true
 *         description: ID of the user's cart to be deleted.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successful response when the cart is deleted.
 *       404:
 *         description: Cart not found.
 *       500:
 *         description: Internal Server Error.
 */
app.delete('/carts/:cartId', verifyToken, async (req, res) => {
    try {
        const { cartId } = req.params;
        const cart = await Cart.findOneAndDelete({  _id: cartId  });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        res.status(200).json({ message: 'Cart deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
