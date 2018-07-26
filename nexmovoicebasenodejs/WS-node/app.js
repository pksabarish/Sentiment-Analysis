require('dotenv').config()

var WebSocketServer = require('websocket').server;
var express = require('express');
var app = express();
var cors = require('cors');

var http = require('http');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
const fs = require('fs');
const winston = require('winston')
winston.level = process.env.LOG_LEVEL || 'info'

var AsrClient = require('./lib/asrClient')
var asrActive = false
var myAsrClient;
var engineStartedMs;
var connections = []
var sentimentScore = [];
var LocalStorage = require('node-localstorage').LocalStorage;
var localStorage = new LocalStorage('./scratch');

localStorage.setItem("isTerminated", "false");
// app.use(function (req, res) {
//     console.log("called here");
//     res.header("Access-Control-Allow-Origin", "*"); 
//     res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept"); 
//     next(); 
// });
app.use(cors({ origin: true, credentials: true }));
// app.use(cors());
//Create a server
var server = http.createServer(function (req, res) {
    handleRequest(req, res);
});

// Loading socket.io
var io = require('socket.io').listen(server);

// When a client connects, we note it in the console
io.sockets.on('connection', function (socket) {
    console.log("A client connected")
    //winston.log('info','A client is connected!');
});

var wsServer = new WebSocketServer({
    httpServer: server,
    autoAcceptConnections: true,
    binaryType: 'arraybuffer'
});

//Lets use our dispatcher
function handleRequest(request, response) {
    try {
        //log the request on console
        winston.log('info', 'handleRequest', request.url);
        //Dispatch
        dispatcher.dispatch(request, response);
    } catch (err) {
        console.log(err);
    }
}
dispatcher.setStatic('/public');
dispatcher.setStaticDirname('public');
dispatcher.onGet("/", function (req, res) {
    winston.log('info', 'loading index');
    winston.log('info', 'port', process.env.PORT)
    fs.readFile('./public/index.html', 'utf-8', function (error, content) {
        winston.log('debug', 'loading Index');
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
    });
});
//send sentiment to inContact

dispatcher.onGet("/push-info", function (req, res) {
    var pushObj = {
        "agentId": req.params.agentId,
        "uuid": req.params.uuid
    }
    function intervalFunc() {
        localStorage.getItem("isTerminated") == "true"
        {
            clearInterval(intervalFunc);
        }
        //  res.writeHead(200, { 'Content-Type': 'application/json' });
        var headers = { 
            "Access-Control-Allow-Origin": "*", 
            'Content-Type': 'application/json', 
            "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept" 
        };
        res.writeHead(200, headers);
        res.end(localStorage.getItem("sentimentInfo"), 'utf-8');
       
    };
    setInterval(intervalFunc, 3000);
})

// Serve the ncco
dispatcher.onGet("/ncco", function (req, res) {
    fs.readFile('./ncco.json', function (error, data) {
        winston.log('debug', 'loading ncco');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data, 'utf-8');
    });
});

dispatcher.onPost("/terminate", function (req, res) {
    winston.log('info', 'terminate called');
    wsServer.closeAllConnections();
    localStorage.setItem("isTerminated", "true");
    localStorage.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end();
});

wsServer.on('connect', function (connection) {
    connections.push(connection);

    winston.log('info', (new Date()) + ' Connection accepted' + ' - Protocol Version ' + connection.webSocketVersion);
    connection.on('message', function (message) {

        if (message.type === 'utf8') {
            try {
                var json = JSON.parse(message.utf8Data);
                winston.log('info', "json", json['app']);

                if (json['app'] == "audiosocket") {
                    VBConnect();
                    winston.log('info', 'connecting to VB');
                }

            } catch (e) {
                winston.log('error', 'message error catch', e)
            }
            winston.log('info', "utf ", message.utf8Data);
        }
        else if (message.type === 'binary') {
            // Reflect the message back
            // connection.sendBytes(message.binaryData);
            if (myAsrClient != null && asrActive) {
                winston.log('debug', "sendingDate ", message.binaryData);
                myAsrClient.sendData(message.binaryData)
            }
        }
    });

    connection.on('close', function (reasonCode, description) {
        winston.log('info', (new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
        wsServer.closeAllConnections();

    });
});

wsServer.on('close', function (connection) {
    winston.log('info', 'socket closed');
    if (asrActive) {
        io.sockets.emit('status', "disconnected");
        winston.log('info', 'trying to close ASR client');
        myAsrClient.close();
        myAsrClient = null;
        asrActive = false;
    }
    else {
        winston.log('info', 'asr not active, cant close');
    }
})

wsServer.on('error', function (error) {
    winston.log('error', 'Websocket error', error);
})


var port = process.env.PORT || 8000
server.listen(port, function () {
    winston.log('info', "Server listening on :%s", port);
});

function VBConnect() {

    winston.log('debug', 'load AsrClient');
    myAsrClient = new AsrClient()
    var url = process.env.ASR_URL;
    client_key = process.env.ASR_CLIENT_KEY;
    client_secret = process.env.ASR_CLIENT_SECRET;
    myAsrClient.setup(url, client_key, client_secret, (err) => {
        if (err) {
            return console.error('AsrClient error:', err)
        }
        var controlMessage = {}
        controlMessage.language = 'en-US' // default starting value 
        controlMessage.targetSampleRate = '8' // default starting value 
        controlMessage.sampleRate = '16000'
        controlMessage.windowSize = 10
        myAsrClient.reserveAsr(controlMessage)
        winston.log('debug', "sending control message", controlMessage);

        myAsrClient.subscribeEvent('engineState', (msg) => {
            winston.log('info', 'Engine State Event', msg);
            //localStorage.clearItem("sentimentInfo");
            localStorage.clear();
            sentimentScore = [];
            if (msg === 'ready') {
                asrActive = true
                engineStartedMs = Date.now()
                winston.log('info', 'Setting asrActive to true: ', asrActive, ' this.asrActive ', this.asrActive)
                io.sockets.emit('status', "connected");
            }
        })

        myAsrClient.subscribeEvent('transcript', (msg) => {
            winston.log('debug', 'transcript', msg);
            console.log('transcript==>',msg);
            io.sockets.emit('transcript', msg);
        })

        myAsrClient.subscribeEvent('sentiment', (msg) => {
           // winston.log('debug', 'sentiment', msg);
            sentimentScore = sentimentScore || [];
            sentimentScore.push(msg);
            localStorage.setItem("sentimentInfo", JSON.stringify(sentimentScore));
            io.sockets.emit('sentiment', msg);
            console.log("sentiment===>", msg);
        })


        myAsrClient.subscribeEvent('nlp', (msg) => {
             winston.log('debug', 'nlp', msg);
            io.sockets.emit('nlp', msg);
        })

        myAsrClient.subscribeEvent('keywords', (msg) => {
            winston.log('info', 'keywords', msg);
            io.sockets.emit('keywords', msg);
        })


        myAsrClient.subscribeEvent('latency', (msg) => {
             winston.log('info', 'latency', msg);
            io.sockets.emit('latency', msg);
        })
    })

}