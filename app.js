const express = require('express');
const axios = require('axios').default;
const si = require('systeminformation');
const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const https = require('https');
const fs = require('fs');
const pino = require('pino');
const pretty = require('pino-pretty');
const { exec } = require('child_process');

const app = express();
const PORT = 7002;

// Create a logger instance with pretty printing
const logger = pino(
    {
        level: 'info',
    },
    pretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
    })
);

// Dynamically update password during runtime
let password = process.env.METRICS_API_PASSWORD || 'defaultPassword';

// Function to update password dynamically if needed
const updatePassword = (newPassword) => {
    password = newPassword;
    users['admin'] = password;
};

// Allow updating password via an API endpoint
app.post('/update-password', express.json(), (req, res) => {
    const newPassword = req.body.password;
    if (newPassword) {
        updatePassword(newPassword);
        return res.status(200).send('Password updated successfully.');
    } else {
        return res.status(400).send('New password not provided.');
    }
});

// Ensure the password is always a string and assign it to the users object
const users = {};
users['admin'] = password;

// HTTPS configuration (adjust paths as necessary)
const httpsOptions = {
    key: fs.readFileSync('./key/key.pem'),
    cert: fs.readFileSync('./key/cert.pem'),
};

// Basic authentication middleware for /metrics endpoint
app.use(
    '/metrics',
    basicAuth({
        users: users,
        challenge: true,
        unauthorizedResponse: 'Unauthorized',
    })
);

// Rate limiting middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests, please try again later.',
});

// Apply rate limit to the /metrics endpoint
app.use('/metrics', limiter);

// Function to get system IP address
function getSystemIPAddress() {
    const networkInterfaces = require('os').networkInterfaces();
    for (const interfaceName in networkInterfaces) {
        for (const iface of networkInterfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'Unknown';
}

// Function to get disk usage
async function getDiskUsage() {
    return si.fsSize();
}

// Function to get network speed
async function getNetworkSpeed() {
    const networkStats = await si.networkStats();
    return networkStats.map((network) => ({
        iface: network.iface,
        downloadSpeedInMbit: ((network.rx_bytes * 8) / 1_000_000).toFixed(2),
        uploadSpeedInMbit: ((network.tx_bytes * 8) / 1_000_000).toFixed(2),
    }));
}

// Function to get BIOS information
async function getBiosInfo() {
    return si.bios();
}

// Function to get processor information
async function getProcessorInfo() {
    const cpu = await si.cpu();
    return {
        model: `${cpu.manufacturer} ${cpu.model}`,
        cores: cpu.cores,
        speed: cpu.speed,
    };
}

// Function to get uptime in seconds or minutes
async function getUptime() {
    const uptime = await si.time();
    return {
        uptimeSeconds: uptime.uptime,
        uptimeMinutes: (uptime.uptime / 60).toFixed(2),
    };
}

// Function to get the last system restart time
async function getLastRestartTime() {
    const uptime = await si.time();
    return new Date(Date.now() - uptime.uptime * 1000);
}

// Function to get RAM in MB
async function getRAMInMB() {
    const memory = await si.mem();
    return {
        total: (memory.total / 1024 / 1024).toFixed(2),
        used: (memory.used / 1024 / 1024).toFixed(2),
        available: (memory.available / 1024 / 1024).toFixed(2),
    };
}

// Function to get CPU usage
async function getCpuUsage() {
    const load = await si.currentLoad();
    return load.currentLoad;
}

// Function to get system temperature
async function getSystemTemperature() {
    return si.cpuTemperature();
}

// Function to get top processes
async function getTopProcesses() {
    const processes = await si.processes();
    const topCpu = processes.list.sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    const topMemory = processes.list.sort((a, b) => b.mem - a.mem).slice(0, 5);
    return { topCpu, topMemory };
}



// Function to fetch Docker details
async function getDockerOverview() {
    try {
        const containers = await si.dockerContainers();
        const images = await si.dockerImages();

        // Fetch Docker volumes
        const getVolumes = () =>
            new Promise((resolve, reject) => {
                exec('docker volume ls --format "{{.Name}}"', (err, stdout) => {
                    if (err) return reject(err);
                    const volumeNames = stdout.trim().split('\n');
                    resolve(volumeNames);
                });
            });

        const getVolumeDetails = (volumeName) =>
            new Promise((resolve, reject) => {
                exec(`docker volume inspect ${volumeName}`, (err, stdout) => {
                    if (err) return reject(err);
                    const details = JSON.parse(stdout);
                    resolve({
                        name: volumeName,
                        mountPath: details[0]?.Mountpoint || 'N/A',
                        size: details[0]?.UsageData?.Size || 'Unknown',
                    });
                });
            });

        const volumes = await getVolumes();
        const volumeDetails = await Promise.all(volumes.map(getVolumeDetails));

        // Fetch Docker networks
        const getNetworks = () =>
            new Promise((resolve, reject) => {
                exec('docker network ls --format "{{.Name}}"', (err, stdout) => {
                    if (err) return reject(err);
                    const networks = stdout.trim().split('\n');
                    resolve(networks);
                });
            });

        const networks = await getNetworks();

        return {
            totalContainers: containers.length,
            runningContainers: containers.filter((c) => c.state === 'running').length,
            stoppedContainers: containers.filter((c) => c.state === 'exited').length,
            totalImages: images.length,
            volumes: {
                count: volumes.length,
                details: volumeDetails,
            },
            networks: {
                count: networks.length,
                names: networks,
            },
        };
    } catch (error) {
        logger.error(`Error fetching Docker details: ${error.message}`);
        return { error: `Docker error: ${error.message}` };
    }
}

// Gather all system metrics with error handling
async function gatherMetrics() {
    const result = {
        serverDetails: {},
        hardware: {},
        performance: {},
        systemTemperature: null,
        topProcesses: null,
        dockerSpecific: null,
    };

    try {
        result.serverDetails.osInfo = await si.osInfo();
    } catch (error) {
        logger.error(`Error fetching OS info: ${error.message}`);
        result.serverDetails.osInfo = { error: 'Failed to fetch OS info' };
    }

    try {
        result.serverDetails.ipAddress = getSystemIPAddress();
    } catch (error) {
        logger.error(`Error fetching system IP address: ${error.message}`);
        result.serverDetails.ipAddress = 'Unknown';
    }

    try {
        result.serverDetails.uptime = await getUptime();
    } catch (error) {
        logger.error(`Error fetching uptime: ${error.message}`);
        result.serverDetails.uptime = { error: 'Failed to fetch uptime' };
    }

    try {
        result.serverDetails.lastRestartTime = await getLastRestartTime();
    } catch (error) {
        logger.error(`Error fetching last restart time: ${error.message}`);
        result.serverDetails.lastRestartTime = 'Unknown';
    }

    try {
        result.hardware.biosInfo = await getBiosInfo();
    } catch (error) {
        logger.error(`Error fetching BIOS info: ${error.message}`);
        result.hardware.biosInfo = { error: 'Failed to fetch BIOS info' };
    }

    try {
        result.hardware.processor = await getProcessorInfo();
    } catch (error) {
        logger.error(`Error fetching processor info: ${error.message}`);
        result.hardware.processor = { error: 'Failed to fetch processor info' };
    }

    try {
        result.hardware.RAMInMB = await getRAMInMB();
    } catch (error) {
        logger.error(`Error fetching RAM info: ${error.message}`);
        result.hardware.RAMInMB = { error: 'Failed to fetch RAM info' };
    }

    try {
        result.hardware.diskUsage = await getDiskUsage();
    } catch (error) {
        logger.error(`Error fetching disk usage: ${error.message}`);
        result.hardware.diskUsage = { error: 'Failed to fetch disk usage' };
    }

    try {
        result.performance.cpuUsage = await getCpuUsage();
    } catch (error) {
        logger.error(`Error fetching CPU usage: ${error.message}`);
        result.performance.cpuUsage = { error: 'Failed to fetch CPU usage' };
    }

    try {
        result.performance.loadAvg = await si.currentLoad();
    } catch (error) {
        logger.error(`Error fetching load average: ${error.message}`);
        result.performance.loadAvg = { error: 'Failed to fetch load average' };
    }

    try {
        result.performance.networkSpeed = await getNetworkSpeed();
    } catch (error) {
        logger.error(`Error fetching network speed: ${error.message}`);
        result.performance.networkSpeed = { error: 'Failed to fetch network speed' };
    }

    try {
        result.systemTemperature = await getSystemTemperature();
    } catch (error) {
        logger.error(`Error fetching system temperature: ${error.message}`);
        result.systemTemperature = { error: 'Failed to fetch system temperature' };
    }

    try {
        result.topProcesses = await getTopProcesses();
    } catch (error) {
        logger.error(`Error fetching top processes: ${error.message}`);
        result.topProcesses = { error: 'Failed to fetch top processes' };
    }

    try {
        result.dockerSpecific = await getDockerOverview();
    } catch (error) {
        logger.error(`Error fetching Docker overview: ${error.message}`);
        result.dockerSpecific = { error: 'Failed to fetch Docker overview' };
    }

    return result;
}

// Endpoint to collect metrics
app.get('/metrics', async (req, res) => {
    try {
        const metrics = await gatherMetrics();
        logger.info('Collected Metrics:', metrics);
        res.json(metrics);
    } catch (error) {
        logger.error(`Error collecting metrics: ${error.message}`);
        res.status(500).send('Error collecting metrics: ' + error.message);
    }
});

// Start HTTPS server
https.createServer(httpsOptions, app).listen(PORT, () => {
    logger.info(`Metrics collector running on https://localhost:${PORT}`);
});
