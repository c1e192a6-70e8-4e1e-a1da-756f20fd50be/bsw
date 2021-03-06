'use strict';

const _ = require('lodash');
const co = require('co');
const bb = require('bluebird');
const moment = require('moment');
const Beanstalk = require('fivebeans').client;

const events = require('events');

class WorkerConnection extends events.EventEmitter {
	constructor(config) {
		super();
		let config_keys = _.keys(config);

		this.client = null;
		this.reserved_counter = 0;
		this.parse = _.includes(config_keys, 'parse') ? config.parse : true;
		this.logging = _.includes(config_keys, 'log') ? config.log : true;
		this.logger = _.includes(config_keys, 'logger') ? config.logger : console.log;
		this.host = _.includes(config_keys, 'host') ? config.host : '127.0.0.1';
		this.port = _.includes(config_keys, 'port') ? config.port : 11300;
		this.tube = _.includes(config_keys, 'tube') ? config.tube : 'default';
		this.timeout = _.includes(config_keys, 'timeout') ? config.timeout : 1;
		this.reserved_limit = _.includes(config_keys, 'max') ? config.max : 1;

		this.handler = this._wrapHandler(this.tube, config.handler);
	}

	log() {
		// console.log.apply(null, arguments);
		// return;

		if (!this.logging) return;
		let _this = this;

		let res_str = `${moment.utc().format('YYYY-MM-DD HH:mm:ss UTC')} ${_this.tube}`;
		for (let arg of arguments) {
			let str = arg;
			if (_.isObject(str)) {
				str = JSON.stringify(str);
			}
			res_str = `${res_str} ${str}`;
		}
		let args = [];
		for (let line of res_str.match(/.{1,120}/g)) {
			args.push(`${line}\n\t`);
		}
		args[args.length - 1] = args[args.length - 1].trim();
		this.logger.apply(null, args);
	}

	_wrapHandler(tube, handler) {
		let _this = this;
		let handler_obj = handler;

		if (_.isString(handler)) {
			handler_obj = require(handler);
		}

		return function (payload, job_info) {
			co(function* () {
				let action = null;
				let result_or_error = null;
				let obj = new handler_obj(job_info);
				let start_time = moment.utc();
				_this.log(`${job_info.id}:`, 'reserved', `(${JSON.stringify(payload)})`);
				_this.emit('JOB_RESERVED', {
					payload: _.clone(payload),
					job_info: _.clone(job_info)
				});
				try {
					result_or_error = yield obj.run(payload, job_info);
					action = _this._actionFromResult(result_or_error);
				} catch (error) {
					result_or_error = error;
					action = _this._actionFromError(error);
				} finally {
					_this._handleJob.apply(_this, action.concat(job_info));
					let end_time = moment.utc();
					let delta_time_sec = end_time.diff(start_time, 'seconds');
					_this.log(`${job_info.id}:`, 'finised,', action, `${delta_time_sec}s`, `(${JSON.stringify(payload)})`);
					_this.emit('JOB_FINISHED', {
						action,
						payload: _.clone(payload),
						job_info: _.clone(job_info),
						result: result_or_error
					});
					try {
						if (_.isFunction(obj.final)) {
							action.push(result_or_error);
							obj.final.apply(obj, action);  // .concat(result_or_error));
						}
					} catch (e) {
						_this.emit('error', e);
					}
					_this.reserved_counter = _this.reserved_counter - 1;
				}
			});
		};
	}

	_actionFromResult(input) {
		return this._actionFromInput(input, 'success', ['bury', 'release']);
	}

	_actionFromError(input) {
		return this._actionFromInput(input, 'bury', ['success', 'release']);
	}

	_actionFromInput(input, default_action, other_actions) {
		let action = input;
		if (_.isArray(input) && input.length) {
			action = input[0];
		}

		if (_.isString(action)) {
			action = action.toLowerCase();
		}

		if (!_.isString(action) || !_.includes(other_actions, action)) {
			action = default_action;
		}

		let delay = null;
		if (action === 'release') {
			delay = 30;
			if (_.isArray(input) && input.length > 1) {
				delay = _.toNumber(input[1]);
			}
		}

		return [action, delay];
	}

	_handleJob(action, delay, job_info) {
		const _this = this;
		return co(function* () {
			try {
				let job_id = job_info.id;
				if (action === 'bury') {
					yield _this.client.buryAsync(job_id, Beanstalk.LOWEST_PRIORITY);
				} else if (action === 'success') {
					yield _this.client.destroyAsync(job_id);
				} else if (action === 'release') {
					yield _this.client.releaseAsync(job_id, Beanstalk.LOWEST_PRIORITY, delay);
				} else {
					throw new Error(`unknown action ${action}`);
				}
			} catch (err) {
				_this.emit('error', err);
			}
		});
	}

	start() {
		let _this = this;
		if (!this.connected) {
			_this.log(`connecting to beanstalkd at ${this.host}:${this.port}`);
			this._start();
		} else {
			_this.log(`client already connected, skipped`);
		}
	}

	stop() {
		let _this = this;
		_this.connected = false;
		if (_this.client) {
			_this.client.end();
			_this.client = null;
		}
	}

	_start() {
		let _this = this;
		_this.connected = false;

		if (_this.client) {
			_this.stop();
		}

		_this.client = new Beanstalk(_this.host, _this.port);

		_this.client.on('connect', function () {
			_this._onConnect();
		});

		_this.client.on('error', function (e) {
			_this._onConnectionError(e);
		});

		_this.client.on('close', function () {
			_this._onConnectionClose();
		});

		_this.client.connect();
	}

	_onConnectionClose() {
		let _this = this;

		if (_this.client && _this.connected === true) {
			_this.log(`beanstalkd connection closed (${_this.tube}), reconnecting to ${_this.host}:${_this.port}`);
			_this._start();
		}
	}

	_onConnectionError(err) {
		let _this = this;
		_this.log(err);

		co(function* () {
			if (_this.client) {
				if (_.includes(['ECONNREFUSED', 'EHOSTDOWN', 'EHOSTUNREACH', 'ETIMEDOUT'], err.code)) {
					_this.client.end();
					_this.log('after end');
					yield _this._idle(100);
					_this._start();
					_this.log('after connect');
				}
				return;
			}

			_this.emit('error', err);
		});
	}

	_onConnect() {
		let _this = this;

		co(function* () {
			_this.connected = true;
			bb.promisifyAll(_this.client, {multiArgs: true});

			_this.log(`connected to beanstalkd at ${_this.host}:${_this.port}`);
			while (_this.connected && _this.client) {
				try {
					yield _this.client.watchAsync(_this.tube);
					_this.log(`subscribed to ${_this.tube} tube`);
					break;
				} catch (e) {
					yield _this._idle();
				}
			}

			while (_this.connected && _this.client) {
				if (_this.reserved_counter >= _this.reserved_limit) {
					// out of quota
					yield _this._idle();
					continue;
				}

				try {
					let res = yield _this.client.reserve_with_timeoutAsync(_this.timeout);
					let job_id = res[0];
					let job_info = {tube: _this.tube, id: job_id};
					let payload = res[1].toString('utf8');
					if (_this.parse) {
						try {
							let parsed_payload = JSON.parse(payload);
							if (_.isObject(parsed_payload)) payload = parsed_payload;
						} catch (parse_error) {
							// nothing here, payload is already a string
						}
					}
					_this.reserved_counter = _this.reserved_counter + 1;
					try {
						_this.handler(payload, job_info);
					} catch (e) {
						_this.emit('error', e);
					}
				} catch (e) {
					// nothing here
				}
			}
		});
	}

	_idle(timeout) {
		return new Promise((resolve, reject) => {
			setTimeout(function () {resolve();}, timeout || 10000);
		});
	}
}

module.exports = WorkerConnection;
