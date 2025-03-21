// server.js - Express server to serve Influence Warehouse data
import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Setup for running behind a proxy
app.set('trust proxy', true);

// Enable CORS for Google Sheets
app.use(cors());

// Endpoint to get data for a specific entity ID
app.get('/warehouse/:entityId', (req, res) => {
  const entityId = req.params.entityId;
  const outputFile = `warehouse-${entityId}.csv`;
  const outputPath = path.join(__dirname, outputFile);
  
  // Check if we already have a recent file (less than 1 hour old)
  if (fs.existsSync(outputPath)) {
    const stats = fs.statSync(outputPath);
    const fileAge = (new Date().getTime() - stats.mtime.getTime()) / 1000 / 60; // in minutes
    
    // If file exists and is recent, serve it directly
    if (fileAge < 60) { // less than 60 minutes old
      console.log(`Serving cached data for entity ${entityId} (${fileAge.toFixed(2)} minutes old)`);
      return serveFile(outputPath, res);
    }
  }
  
  // Otherwise run the script to generate fresh data
  console.log(`Generating fresh data for entity ${entityId}`);
  
  exec(`node index.js ${entityId} ${outputFile}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing script: ${error.message}`);
      return res.status(500).send('Error generating data');
    }
    
    if (stderr) {
      console.error(`Script stderr: ${stderr}`);
    }
    
    console.log(`Script output: ${stdout}`);
    
    // Check if file was created
    if (fs.existsSync(outputPath)) {
      return serveFile(outputPath, res);
    } else {
      return res.status(500).send('Failed to generate data file');
    }
  });
});

// Helper function to serve CSV file
function serveFile(filePath, res) {
  // Set response headers for CSV
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${path.basename(filePath)}`);
  
  // Stream the file to the response
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
  
  // Handle errors
  fileStream.on('error', (error) => {
    console.error(`Error streaming file: ${error.message}`);
    // Only send error if headers haven't been sent
    if (!res.headersSent) {
      res.status(500).send('Error reading data file');
    }
  });
}

// Simple status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    message: 'Influence Warehouse API is running'
  });
});

// Documentation endpoint
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Influence Warehouse API</title></head>
      <body>
        <h1>Influence Warehouse API</h1>
        <p>Use this API to get warehouse inventory data from Influence.</p>
        <h2>Endpoints:</h2>
        <ul>
          <li><code>/warehouse/{entityId}</code> - Get inventory for a specific warehouse (replace {entityId} with the building ID)</li>
          <li><code>/status</code> - Check API status</li>
        </ul>
        <h2>Google Sheets Example:</h2>
        <pre>=IMPORTDATA("https://your-server-url.com/warehouse/32456")</pre>
      </body>
    </html>
  `);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});