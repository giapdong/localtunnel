const { EventEmitter } = require('events');
const debug = require('debug')('localtunnel:TunnelCluster');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const { Transform } = require('stream');

const HeaderHostTransformer = require('./HeaderHostTransformer');


/**
 * @desc Tip & trick to fix local connection timeout, we will normalize it after
 * @debt 04 Sep 2024
 */
class LocalConnectionListener extends Transform {

	constructor() {
		super();
		this.emitter = new EventEmitter()
	}

	_transform(data, encoding, callback) {
		const isTimeout = data.toString().includes('408 Request Timeout')
		if (isTimeout) {
			this.emitter.emit('local:timeout')
		}

		callback(null, data);
	}


	onTimeout(callback) {
		this.emitter.once('local:timeout', callback)
	}
}

// manages groups of tunnels
module.exports = class TunnelCluster extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
  }

  open() {
    const opt = this.opts;

    // Prefer IP if returned by the server
    const remoteHostOrIp = opt.remote_ip || opt.remote_host;
    const remotePort = opt.remote_port;
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;
    const localProtocol = opt.local_https ? 'https' : 'http';
    const allowInvalidCert = opt.allow_invalid_cert;
	const sessionConnection = opt.session_connection;

    debug(
      'establishing tunnel %s://%s:%s <> %s:%s',
      localProtocol,
      localHost,
      localPort,
      remoteHostOrIp,
      remotePort
    );

    // connection to localtunnel server
	let connecting = false;
    const remote = net.connect({
      host: remoteHostOrIp,
      port: remotePort,
    });

    remote.setKeepAlive(true);

    remote.on('error', err => {
      debug('got remote connection error', err.message);

      // emit connection refused errors immediately, because they
      // indicate that the tunnel can't be established.
      if (err.code === 'ECONNREFUSED') {
        this.emit(
          'error',
          new Error(
            `connection refused: ${remoteHostOrIp}:${remotePort} (check your firewall settings)`
          )
        );
      }

      remote.end();
    });

    const connLocal = () => {
      if (remote.destroyed) {
        debug('remote destroyed');
        this.emit('dead');
        return;
      }

      debug('connecting locally to %s://%s:%d', localProtocol, localHost, localPort);
      remote.pause();

      if (allowInvalidCert) {
        debug('allowing invalid certificates');
      }

      const getLocalCertOpts = () =>
        allowInvalidCert
          ? { rejectUnauthorized: false }
          : {
              cert: fs.readFileSync(opt.local_cert),
              key: fs.readFileSync(opt.local_key),
              ca: opt.local_ca ? [fs.readFileSync(opt.local_ca)] : undefined,
            };

      // connection to local http server
      const local = opt.local_https
        ? tls.connect({ host: localHost, port: localPort, ...getLocalCertOpts() })
        : net.connect({ host: localHost, port: localPort });

      const remoteClose = () => {
        debug('remote close');
        this.emit('dead');
        local.end();
      };

      remote.once('close', remoteClose);

      // TODO some languages have single threaded servers which makes opening up
      // multiple local connections impossible. We need a smarter way to scale
      // and adjust for such instances to avoid beating on the door of the server
      local.once('error', err => {
        debug('local error %s', err.message);
        local.end();

        remote.removeListener('close', remoteClose);

        if (err.code !== 'ECONNREFUSED'
            && err.code !== 'ECONNRESET') {
          return remote.end();
        }

        // retrying connection to local server
        setTimeout(connLocal, 1000);
      });


	  if (sessionConnection) {
		// retrying connection to local server
		// We will distribute closing connection because when all connections close will make close tunnel-wide
		// Minimun 30s make safe for our tunnel server with too many request re-connect
		// Maximum 80s because local stream auto close without signal after about 90s => 80s seem safe
		const actualTimeoutValue = Math.random() * (80_000 - 30_000) + 30_000
		local.setTimeout(actualTimeoutValue);
		local.once('timeout', function() {
			debug('local connection with session-based timeout with connecting:', connecting, actualTimeoutValue);
			if (connecting) {
			} else {
				remote.removeListener('close', remoteClose);
				remote.end();
				remoteClose();
			}
		});
	  }

      local.once('connect', () => {
        debug('connected locally');
        remote.resume();

        let stream = remote;

        // if user requested specific local host
        // then we use host header transform to replace the host header
        if (opt.local_host) {
          debug('transform Host header to %s', opt.local_host);
          stream = remote.pipe(new HeaderHostTransformer({ host: opt.local_host }));
        }

		const timeoutInjector = new LocalConnectionListener()
		// This fix error related local connection timeout => Cannot serve request
		// Handle same as timeout event of remote
		timeoutInjector.onTimeout(function() {
			if (connecting) {
			} else {
				remote.removeListener('close', remoteClose);
				remote.end();
				remoteClose();
			}
		});

        stream
		.pipe(local)
		.pipe(timeoutInjector)
		.pipe(remote);

        // when local closes, also get a new remote
        local.once('close', hadError => {
          debug('local connection closed [%s]', hadError);
        });
      });
    };

    remote.on('data', data => {
      connecting = true;
      const match = data.toString().match(/^(\w+) (\S+)/);
      if (match) {
        this.emit('request', {
          method: match[1],
          path: match[2],
        });
      }
    });

    // tunnel is considered open when remote connects
    remote.once('connect', () => {
      this.emit('open', remote);
      connLocal();
    });
  }
};
