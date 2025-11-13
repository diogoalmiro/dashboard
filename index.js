const FOLDER = process.env.SERVICES_FOLDER;

if( !FOLDER ){
    console.error('SERVICES_FOLDER is not set');
    process.exit(1);
}


const fs = require('fs');
const {fork} = require('child_process');
const {EventEmitter} = require('events');

const processes = {}

const express = require('express');
const app = express();

app.use(express.static('static'));

const eventEmitter = new EventEmitter();

app.get('/processes', (req,res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const writeProcess = (type, processName) => {
        if( res.closed ) return;
        let process = processes[processName];
        let data = {
            name: processName,
        }
        if( process ){
            data.running = process.exitCode == null && !process.killed;
            data.pid = data.running ? process.pid : null;
            data.stdout = process.stdoutArr.join('');
            data.stderr = process.stderrArr.join('');
            data.lastRun = process.lastRun;
            data.lastExit = process.lastExit;
        }
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    for( name in processes ){
        writeProcess('created_process', name);
    }

    const handleUpdateProcess = (name) => {
        writeProcess('updated_process', name);
    }

    const handleKilledProcess = (name) => {
        writeProcess('killed_process', name);
    }

    const handleCreateProcess = (name) => {
        writeProcess('created_process', name);
    }

    eventEmitter.on('created_process', handleCreateProcess);
    eventEmitter.on('update_process', handleUpdateProcess);
    eventEmitter.on('killed_process', handleKilledProcess);

    res.on('close', () => {
        eventEmitter.off('update_process', handleUpdateProcess);
        eventEmitter.off('killed_process', handleKilledProcess);
        eventEmitter.off('created_process', handleCreateProcess);
    })

})

app.post('/kill', express.urlencoded({extended: true}), (req,res) => {
    if( processes[req.body.process] ){
        killService(req.body.process)
    }
    res.status(204).end();
})

app.post('/run', express.urlencoded({extended:true}), (req,res) => {
    if( req.body.process ){
        forkService(req.body.process)
    }
    res.status(204).end();
})

app.listen(6000, 'localhost', () => {
    console.log('Server listening')
})

fs.promises.readdir(FOLDER)
    .then(services =>
        services.forEach(forkService))
    .then(_ => {
        fs.watch(FOLDER, (type, service) => {
            if( type == 'rename' ){
                if( service in processes ){
                    killService(service)
                    delete processes[service];
                    eventEmitter.emit('killed_process', service);
                }
                else {
                    forkService(service)
                }
            }
            if( type == 'change' ){
                killService(service)
                forkService(service)
            }
        })
    })

function killService(service){
    if( !service.endsWith(".js") )
        return;
    console.log('Killed service:', service)
    processes[service]?.kill();
}

function forkService(service){
    if( !service.endsWith(".js") )
        return;
    if( processes[service] && processes[service].exitCode == null && !processes[service].killed )
        return;
    console.log('Spwaned service:', service)
    let process = fork(`${FOLDER}/${service}`, [], {stdio:'pipe'});
    processes[service] = process;
    process.lastRun = new Date();
    process.stdoutArr = [];
    process.stderrArr = [];
    process.stdout.on('data', (data) => {
        process.stdoutArr.push(data.toString())
        while( process.stdoutArr.length > 50){
            process.stdoutArr.shift();
        }
        eventEmitter.emit('update_process', service);
    })
    process.stderr.on('data', (data) => {
        process.stderrArr.push(data.toString())
        while( process.stderrArr.length > 50){
            process.stderrArr.shift();
        }
        eventEmitter.emit('update_process', service);
    })
    eventEmitter.emit('created_process', service);
    process.on('exit', () => {
        process.lastExit = new Date();
        eventEmitter.emit('update_process', service);
    })
}