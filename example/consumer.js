'use strict';

const Worker = require('../index');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(`${__dirname}/config.json`));

let worker = new Worker({
	host: config.host,
	port: config.port,
	tube: config.tube,
	max: 3,
	handler: `${__dirname}/consumer_handler`,
	logger: function logger() {
		console.log('beanstalkd workder:', Array.prototype.join.call(arguments, ' '));
	}
});
worker.start();
