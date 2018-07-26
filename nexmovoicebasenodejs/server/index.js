require('dotenv').config()
var express = require('express')
var app = express()
var bodyParser = require('body-parser');
var Nexmo = require('nexmo');
var Promise = require('bluebird');
var util = require("util");
const winston = require('winston')
var LocalStorage = require('node-localstorage').LocalStorage;
var localStorage = new LocalStorage('./scratch');
var request = require('request')
var async = require('async')

var executed = false;
var didStart = false
var USER_NUMBER = ""
var WEB_SOCKET='ws://'+process.env.WEB_SOCKET_URL+'/socket';


var SMS_TEXT = "View the transcription service here: " + "http://" + process.env.WEB_SOCKET_URL;
var converstationIDs = [];
var connectedUsers = [];
var Transfer_Number = [];

var ORIGIN_NUMBER = [];

var nexmo = new Nexmo({
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    applicationId: process.env.APPLICATION_ID,
    privateKey: __dirname + '/' + process.env.PRIVATE_KEY_PATH
},
    { debug: process.env.NEXMO_DEBUG }
);

winston.level = process.env.LOG_LEVEL
var calls = Promise.promisifyAll(nexmo.calls);

app.set('port', process.env.PORT || 8081)
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));


//winston.log('debug', 'env vars', process.env);

app.get('/answer', function (req, res) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    winston.log('info', 'answer route called', req.body);
    reset()
    var url = require('url');
    var url_parts = url.parse(req.url, true);
    var query = url_parts.query;

    connectedUsers.push(query.from);
    //winston.log('debug', 'adding user to sms list', connectedUsers);

    if (process.env.SINGLE_USER) {
        winston.log('debug', 'In single user mode');
        var json = [{
            "action": "connect",
            "eventUrl": [
                "http://" + req.headers.host + "/events"
            ],
            "from": query.from,
            "endpoint": [{
                "number": process.env.TO_NUMBER,
                "type": "phone"
            }]
        },{
            "action": "connect",
            "eventUrl": [
                "http://" + req.headers.host + "/events"
            ],
            "from": query.from,
            "endpoint": [{
                "type": "websocket",
                "uri": WEB_SOCKET,
                "content-type": "audio/l16;rate=16000",
                "headers": {
                    "app": "audiosocket"
                }
            }]
        }]
        winston.log('info', 'SingleUser Json', json);
        res.send(json)
        return
    }

    if (process.env.TO_NUMBER) {
        var json = [
            {
                "action": "talk",
                "text": "Calling user"
            },
            {
                "action": "conversation",
                "name": process.env.CONFERENCE_NAME,
                "endOnExit": "false"
            }
        ]

        var to = {
            type: 'phone',
            number: process.env.TO_NUMBER,
        }
        winston.log('info', 'answer JSON', json);
        dial(to, process.env.NEXMO_NUMBER, req.headers.host, function (result) {
            winston.log('info', 'dial result', result);
            res.send(json)
        })

    } else {
        var baseURL = "http://" + req.headers.host;
        var json = [
            {
                "action": "talk",
                "text": "Please enter a phone number to call, press the pound key when complete",
                "bargeIn": "false"
            },
            {
                "action": "input",
                "submitOnHash": true,
                "timeOut": 60,
                "maxDigits": 20,
                "eventUrl": [baseURL + "/events_ivr"]
            },
            {
                "action": "conversation",
                "name": process.env.all_sales.jsoCONFERENCE_NAME,
                "endOnExit": "true",
            }
        ]

        //winston.log('info', 'answer JSON', json);
        res.send(json)
    }
})

app.get('/conference', function (req, res) {
    console.log("conf json")

    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    var url = require('url');
    var url_parts = url.parse(req.url, true);
    var query = url_parts.query;
    var json = [
       {
            "action": "conversation",
            "name": process.env.CONFERENCE_NAME,
            "startOnEnter": "false"
        }
    ]
    winston.log('info', 'conference JSON', json);
    res.send(json)

})




app.post('/events_ivr', function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    winston.log('info', 'events_ivr', req.body);

    var baseURL = req.headers.host;
    var number = req.body.dtmf;
    var from = req.body.from;

    USER_NUMBER = number

    if (number == '' || number.length < 11) {
        winston.log('debug', 'could not get dtmf number', number);
        var json = [
            {
                "action": "talk",
                "text": "Sorry, I did not get that phone number. Goodbye"
            }
        ]
        res.send(json);
    } else {
        var to = {
            type: 'phone',
            number: number,
        }
        dial(to, process.env.NEXMO_NUMBER, baseURL, function (result) {
            winston.log('info', 'IVR Dial result', result);
        })

        res.sendStatus(200);
    }

});

app.post('/events', function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    //winston.log('info', 'events', req.body);
    console.log("req.body==>", req.body)

    var baseURL = req.headers.host;
    var from = req.body.from;
    if (req.body.status == "answered") {
        converstationIDs.push(req.body.uuid);
        var tempObj = {
            "uuid": req.body.uuid,
            "from": req.body.from,
            "to": req.body.to
        };
        localStorage.setItem(req.body.from, JSON.stringify(tempObj));


        // winston.log('debug', 'adding converstaion uuid', converstationIDs);
    } else if (req.body.status == "completed") {
        // winston.log('debug', 'called ended', req.body);
        console.log(" call completed req.body==>", req.body)
        winston.log('debug', 'calling hangup');
        // performHangup()
        var jwt = nexmo.generateJwt();
        async.forEach(converstationIDs, function (id, calbk) {
            // request({ url: 'https://api.nexmo.com/v1/calls/' + id, method: 'PUT', headers : {"Authorization" : "Bearer " + jwt}, body : {
            //     "action": 'hangup'
            // }},
            // function optionalCallback(err, httpResponse, body) {
            //     if (err) {
            //         return console.error('failed:', err);
            //     }
            //     console.log('successful!  Server responded with:', body);
            //     calbk();
            // })
            request({
                url: 'https://api-us-1.nexmo.com/v1/calls/' + id,
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + jwt,
                    "Content-Type": "application/json; charset=utf8",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    "action": "hangup"
                })
            }, (err, res, body) => {
                if (err) {
                    console.log('Err', err)
                    // res.end()
                    calbk()
                } else {
                    //console.log("success");
                    // res.end()
                    calbk()
                }
            })
        })

    }
    res.sendStatus(200);
});



app.get('/get-uuid', function (req, res) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    console.log("GET CALL:::::::::::::::::::::::", req.query);
    console.log("**** Get Details *********", localStorage.getItem(req.query.phone));
    res.send(JSON.parse(localStorage.getItem(req.query.phone)));
   
});


var performHangup = (function () {
    return function () {
        winston.log('debug', "executed " + executed + " didStart " + didStart)
        if (!executed && !didStart) {
            didStart = true
            hangupCalls(function () {
                executed = true;
                winston.log('info', 'hangup complete');
            })
        }
    };
})();

process.on('unhandledRejection', (reason) => {
     winston.log('error', 'unhandledRejection', reason)
});

app.listen(process.env.PORT || 8081, function () {
    winston.log('info', 'Nexmo Phone app listening on port ' + (process.env.PORT || 8081))
})


function dial(to, from, serverURL, callback) {
    var json = {
        to: [to],
        from: {
            type: 'phone',
            number: process.env.NEXMO_NUMBER
        },
        answer_url: ['http://' + serverURL + '/conference'],
        event_url: ['http://' + serverURL + '/events', 'http://' + process.env.WEB_SOCKET_URL + '/events']
    }
    winston.debug('debug', 'dial JSON', json);
    calls.createAsync(json).then(function (res) {
         winston.log('debug', 'call created', res)
        callback(res)
    })
}

function hangupCalls(callback) {

    Promise.each(converstationIDs, function (converstationID) {
        return new Promise(function (resolve, reject) {
            calls.updateAsync(converstationID, { action: 'hangup' })
                .then(function (resp) {
                    setTimeout(function () {
                         winston.log('info', 'hangup result: for id: ' + converstationID, resp)
                        resolve();
                    }, 2000)

                })
        });

    })
        .then(function (allItems) {
              winston.log('debug', 'all items', allItems)
            callback();
        })
}

function terminate(callback) {
    winston.log('debug', 'calling terminate');
    var request = require('request');
    request({
        url: 'http://' + process.env.WEB_SOCKET_URL + '/terminate',
        method: 'POST',
        json: true,
        headers: { 'content-type': 'application/json' },
    }, (err, res, body) => {
        winston.log('debug', 'terminate called');
        callback()
    })
}

function reset() {
    connectedUsers.length = 0
    converstationIDs.length = 0;
    executed = false;
    didStart = false;
    localStorage.clear();
}

