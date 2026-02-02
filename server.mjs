// APN — Express server + GUN relay peer
// Serves static site and acts as a GUN relay for decentralized P2P sync
import express from 'express';
import http from 'http';
import Gun from 'gun';

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('.', {
  index: 'index.html',
  extensions: ['html'],
}));

// Health check for Railway
app.get('/api/health', (req, res) => {
  res.json({ name: 'APN — Agent Production Network', status: 'running', gun: true });
});

// Catch-all → index.html (SPA)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/gun')) {
    res.sendFile('index.html', { root: '.' });
  }
});

const server = http.createServer(app);

// Attach GUN as relay peer on this server
// All connected browsers sync through this node
Gun({ web: server, file: 'gun-data' });

server.listen(PORT, () => {
  console.log(`APN running on port ${PORT}`);
  console.log(`GUN relay peer active — browsers sync through this node`);
});
