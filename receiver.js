const express = require('express');
const basicAuth = require('express-basic-auth');

const app = express();
const PORT = 4000;

// Function to get dynamic password during runtime
let receiverPassword = process.env.RECEIVER_API_PASSWORD || 'defaultReceiverPassword';

// Function to update password dynamically if needed
const updateReceiverPassword = (newPassword) => {
    receiverPassword = newPassword;
};

// Allow updating password via an API endpoint
app.post('/update-receiver-password', express.json(), (req, res) => {
    const newPassword = req.body.password;
    if (newPassword) {
        updateReceiverPassword(newPassword);
        return res.status(200).send('Receiver password updated successfully.');
    } else {
        return res.status(400).send('New password not provided.');
    }
});

// Use basic authentication for /receive-metrics endpoint with dynamic password
app.use('/receive-metrics', basicAuth({
    users: () => ({ 'admin': receiverPassword }),
    challenge: true,
    unauthorizedResponse: 'Unauthorized'
}));

app.use(express.json()); // Middleware to parse JSON bodies

app.post('/receive-metrics', (req, res) => {
    console.log('Received Metrics:', req.body);
    res.status(200).send('Metrics received');
});

app.listen(PORT, () => {
    console.log(`Metrics receiver running on http://localhost:${PORT}`);
});
