const FOLDER = process.env.SERVICES_FOLDER;

if( !FOLDER ){
    console.error('SERVICES_FOLDER is not set');
    process.exit(1);
}

const PORT = parseInt(process.env.PORT || '6000');

if( isNaN(PORT) ){
    console.error('PORT is not a number');
    process.exit(1);
}


const fs = require('fs');
const {fork, exec, execSync} = require('child_process');
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
            data.localAddress = data.running ? process.localAddress : null;
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

app.post('/restart', express.urlencoded({extended:true}), (req,res) => {
    if( req.body.process ){
        killService(req.body.process)
        forkService(req.body.process)
    }
    res.status(204).end();
})

app.listen(PORT, 'localhost', () => {
    console.log('Server listening')
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


async function getLocalAddresses(){
    let lines = await new Promise((resolve, reject) => {
        let proces = exec(`netstat -tulpn 2> /dev/null | grep -i listen | tr -s " " ","`, {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000});
        let stdout = '';
        proces.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        proces.on('exit', () => {
            if( proces.exitCode == 0){
                resolve(stdout.trim().split('\n'));
            }
            else {
                reject(new Error(`Failed to get ports: ${proces.exitCode}`));
            }
        });
    });
    let localAddresses = {};
    for( let line of lines ){
        if( line.trim() == '' ) continue;
        let [_protocol, _1, _2, localAddress, _remoteAddress, _3, pidProcess] = line.split(',');
        let pid = pidProcess.split('/').at(0);
        localAddresses[pid] = localAddress;
    }
    return localAddresses;
}

// After a process is created, wait an update all running processes ports
let updatingLocalAddresses = false;
eventEmitter.on('created_process', (service) => {
    if( updatingLocalAddresses ) return;
    updatingLocalAddresses = true;
    setTimeout(() => {
        getLocalAddresses().then(localAddresses => {
            console.log('Local addresses:', localAddresses);
            for( let processName in processes ){
                let process = processes[processName];
                let localAddress = localAddresses[process.pid];
                if( localAddress ){
                    process.localAddress = localAddress;
                    eventEmitter.emit('update_process', processName);
                }
            }
        }).catch(error => {
            console.error(error);
        }).finally(() => {
            updatingLocalAddresses = false;
        });
    }, 1500);
});

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