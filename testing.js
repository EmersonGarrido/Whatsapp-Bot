const qrcode = require('qrcode-terminal');

const { Client } = require('whatsapp-web.js');
const client = new Client();

client.on('qr', qr => {
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', message => {
    if(message.body === 'Boa tarde') {
        client.sendMessage(message.from, 'Boa tarde, Gostaria de um atendimento para qual setor?');
        client.sendMessage(message.from, '1 - Atendimento');
        client.sendMessage(message.from, '2 - Suporte');
        client.sendMessage(message.from, '3 - Outros');
    }
    if(message.body === '1'){
        client.sendMessage(message.from, 'Já iremos realizar seu atendimento?');
    }
    if(message.body === '2'){
        client.sendMessage(message.from, 'Já iremos abrir seu suporte?');
    }
    if(message.body === '3'){
        client.sendMessage(message.from, 'Me diga qual seria sua solicitacao?');
    }
});

client.initialize();