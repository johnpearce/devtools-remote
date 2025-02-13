var express = require('express')
var cors = require('cors')
var http = require('http')
var WebSocketServer = require('ws').Server
var Mixpanel = require('mixpanel')

var logger = require('./logger')
var uuid = require('node-uuid')
var request = require('request')

var targets = {}
var sockets = {}
var sessions = {}
var mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN)

logger.info('server.booting')

// HTTP for /json endpoint
logger.info('http.booting')

var app = express()
app.use(cors({
  origin: function(origin, callback){
    // allow requests with no origin
    // (like mobile apps or curl requests)
    if(!origin) return callback(null, true);
    return callback(null, true);
  },
}));

app.set('port', process.env.PORT || 8000)

app.use(express.static('web'))

app.get('/', function (req, res) {
  logger.info('http.index')
  res.json({
    msg: 'Hello from DevToolsRemote'
  })
})

app.get('/_stats', function (req, res) {
  logger.info('http.stats')
  res.json({
    count: {
      targets: Object.keys(targets).length,
      sockets: Object.keys(sockets).length,
      sessions: Object.keys(sessions).length
    }
  })
})

app.get('/:session/json', function (req, res) {
  var sessionId = req.params.session
  var sessionTargets = targets[sessionId]

  logger.info('http.targets', {
    targets: sessionTargets
  })

  res.send(sessionTargets)
})

var server = http.Server(app)

server.listen(app.get('port'), function () {
  logger.info('http.listening')
  logger.info('- listening on port %d in %s mode', app.get('port'), app.settings.env)
})

// Socket IO for Chrome Extension
logger.info('socket.booting')

var io = require('socket.io')(server)
io.sockets.on('connection', function (socket) {
  var sessionId = uuid()

  logger.info('socket.connection', sessionId)

  targets[sessionId] = []
  sockets[sessionId] = socket
  sessions[sessionId] = {
    startTime: new Date().getTime()
  }

  socket.on('disconnect', function () {
    logger.info('socket.disconnect')

    var session = sessions[sessionId]
    var endTime = new Date().getTime()
    var duration = endTime - session.startTime

    mixpanel.track('session_ended', {
      sessionId: sessionId,
      endTime: endTime,
      startTime: session.startTime,
      duration: duration
    })

    mixpanel.track('sessions_duration', {
      sessionId: sessionId
    })

    delete targets[sessionId]
    delete sockets[sessionId]
    delete sessions[sessionId]
  })

  socket.on('error', function (err) {
    logger.error('socket.error', err)
  })

  socket.on('hello', function (data) {
    logger.info('socket.hello', data)

    var webSocketUrl = (process.env.WEBSOCKET_DOMAIN ? process.env.WEBSOCKET_DOMAIN : ('localhost:' + app.get('port'))) + '/devtools/page/' + sessionId

    targets[sessionId].push({
      description: '',
      devtoolsFrontendUrl: '/devtools/devtools.html?ws=' + webSocketUrl,
      devtoolsUrl: 'chrome-devtools://devtools/bundled/inspector.html?wss=' + webSocketUrl + '&remoteFrontend=true&dockSide=unlocked&experiments=true',
      id: uuid(),
      title: data.title,
      type: 'page',
      url: data.url,
      webSocketDebuggerUrl: 'ws://' + webSocketUrl
    })

    mixpanel.track('sessions_created', {
      sessionId: sessionId
    })

    socket.emit('sessionCreated', sessionId)
  })
})

// Native WebSockets for DevTools
logger.info('websocket.booting')

var extractPageId = function (str) {
  return str.match(/\/devtools\/page\/(.*)/)[1]
}

var ws = new WebSocketServer({
  server: server,
  path: /\/devtools\/page\/(.*)/
})

ws.on('error', function (err) {
  logger.error('websocket.error', err)
})

ws.on('connection', function (connection) {
  var pageId = extractPageId(connection.upgradeReq.url)
  var socket = sockets[pageId]

  if (!socket) {
    return connection.close(1011, 'Matching socket not found :/')
  }

  var forwardMessage = function (data) {
    var response = JSON.stringify(data)
    logger.info('forwardMessage', data.id)
    connection.send(response)
  }

  socket.on('data.response', function (data) {
    logger.info('data.response', data.id)
    forwardMessage(data)
  })

  socket.on('data.event', function (data) {
    logger.info('data.event', data.method)
    forwardMessage(data)
  })

  logger.info('websocket.connected', pageId)

  connection.on('close', function (data) {
    logger.info('websocket.close')

    socket.removeAllListeners('data.response')
    socket.removeAllListeners('data.event')
  })

  connection.on('error', function (err) {
    logger.error('websocket.error', err)
  })

  connection.on('message', function (data) {
    logger.info('websocket.message')

    var message;
    try {
      message = JSON.parse(data);
    } catch (e) { }

    if (!message) return;
    socket.emit('data.request', message)
  })
});
