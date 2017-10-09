'use strict';

var FS = require( 'fs' );
var CP = require( 'child_process' );
var Emitter = require( 'events' ).EventEmitter;
var temporal = require( 'temporal' );
var tick = process.setImmediate || process.nextTick;

var MODES = Object.freeze( require( './modes.json' ) );
var pinGroups = require( './pingroups-omega2.json' );

// assign pin modes for each pin based on group membership
var pinModes = [];
for ( var groupName = 0; groupName < pinGroups.length; groupName++ ) {
	var group = pinGroups[ groupName ];
	for ( var i = 0; i < group.pins.length; i++ ) {

		var pin = pinModes[ group.pins[ i ] ] || {
			modes: []
		};
		pin.modes = pin.modes.concat( group.modes );
		pinModes[ group.pins[ i ] ] = pin;
	}
}

// redundancy for group names
pinGroups.ANALOG = pinGroups.PWM;

var boards = [];
var _i2cBus;
var _i2cPollDelay; // delay before each i2c read in milliseconds

function Omega2( opts ) {
	Emitter.call( this );

	opts = opts || {};

	if ( !( this instanceof Omega2 ) ) {
		return new Omega2( opts );
	}

	this.name = 'Omega2-IO';

	this.pins = pinModes.map( function( pin, index ) {
		return {
			index: index,
			port: index,
			supportedModes: pin.modes,
			value: 0,
			report: 0,
			mode: null,
			isPwm: false
		};
	}, this );

	// TODO
	this.analogPins = [];

	boards[ 0 ] = this;

	this.defaultLed = 44;
	this.isReady = false;
	tick( function() {
		this.isReady = true;
		this.emit( 'connect' );
		this.emit( 'ready' );
	}.bind( this ) );

	if (opts.simulated === true) {
		CP = require( './child_process_simulated' );
		console.log("--SIMULATED MODE--");
	}
}

Omega2.reset = function() {
	return null;
};

Omega2.prototype = Object.create( Emitter.prototype, {
	constructor: {
		value: Omega2
	},
	MODES: {
		value: MODES
	},
	HIGH: {
		value: 1
	},
	LOW: {
		value: 0
	}
} );

Omega2.prototype.pinMode = function( pinIndex, mode ) {
	var pin = {
		mode: mode
	};

	this.pins[ pinIndex ] = pin;

	if (mode != MODES.INPUT) {
		if (pin.temporal) {
			pin.temporal.stop();
			pin.temporal = null;
		}
	}

	switch ( mode ) {
		case MODES.OUTPUT:
			CP.spawn( 'fast-gpio', [ 'set-output', pinIndex ] );
			pin.mode = MODES.OUTPUT;
			pin.isPwm = false;
			break;

		case MODES.INPUT:
			CP.spawn( 'fast-gpio', [ 'set-input', pinIndex ] );
			pin.mode = MODES.INPUT;
			pin.isPwm = false;
			break;

		case MODES.ANALOG:
			// intentional fallthrough
		case MODES.PWM:
			CP.spawn( 'fast-gpio', [ 'set-output', pinIndex ] );
			pin.mode = MODES.PWM;
			pin.isPwm = true;
			break;

		case MODES.SERVO:
			console.error( 'Omega2 doesn\'t support servo mode' );
			break;
	}

	return this;
};


Omega2.prototype.analogWrite = function( pin, value, dutycycle ) {
	if ( this.pins[ pin ].mode !== MODES.PWM ) {
		this.pinMode( pin, MODES.PWM );
	}

	this.pins[ pin ].value = value;

	if (value == 0) {
		CP.spawn( 'fast-gpio', [ 'set', pin, 1 ] );
	} else {
		CP.spawn( 'fast-gpio', [ 'pwm', pin, value, 200 ] );
	}

	return this;
};

Omega2.prototype.pwmWrite = Omega2.prototype.analogWrite;

Omega2.prototype.digitalRead = function( pinIndex, handler ) {
	var pin = this.pins[ pinIndex ];
	if ( this.pins[ pinIndex ].mode !== this.MODES.INPUT ) {
		this.pinMode( pinIndex, this.MODES.INPUT );
	}

	var read = function () {
		var cp = CP.spawn( 'fast-gpio', [ '-u', 'read', pinIndex ] );
		cp.on( 'error', function( err ) {
			return console.error( 'Error reading Omega2 pin ' + pinIndex, err );
		});
		cp.stdout.on( 'data', function( data ) {
			data = JSON.parse(data.toString());
			var val = parseInt(data.val);

			if (pin.value !== val) {
				pin.value = val;
				handler(val);
			}
		} );
		cp.on( 'exit', function() {
			handler( pin.value );
		} );
	}

	read();
	pin.temporal = temporal.loop(50, read);

	return this;
};

Omega2.prototype.digitalWrite = function( pin, value ) {
	if ( this.pins[ pin ].mode !== this.MODES.OUTPUT ) {
		this.pinMode( pin, this.MODES.OUTPUT );
	}

	this.pins[ pin ].value = value;
	CP.spawn( 'fast-gpio', [ 'set', pin, value ] );

	return this;
};


Omega2.prototype.i2cConfig = function( options ) {
	_i2cPollDelay = 0;
	if ( typeof options === 'number' ) {
		_i2cPollDelay = 1000 / options;
	} else {
		if ( typeof options === 'object' && options !== null ) {
			_i2cPollDelay = 1000 / options.frequency || options.delay;
		}
	}
	return this;
};

// this method supports both
// i2cWrite(address, register, inBytes)
// and
// i2cWrite(address, inBytes)
Omega2.prototype.i2cWrite = function( address, cmdRegOrData, inBytes ) {
	/**
	 * cmdRegOrData:
	 * [... arbitrary bytes]
	 *
	 * or
	 *
	 * cmdRegOrData, inBytes:
	 * command [, ...]
	 *
	 */
	var buffer;

	this.i2cConfig();

	// Fix arguments if called with Firmata.js API
	if ( arguments.length === 2 ) {
		if (Array.isArray(cmdRegOrData)) {

			inBytes = cmdRegOrData.slice();
			cmdRegOrData = inBytes.shift();

			if (inBytes.length === 1) {
				inBytes = inBytes.shift();
			}
		} else {
			inBytes = [];
		}
	}

	// If i2cWrite was used for an i2cWriteReg call...
	if ( !Array.isArray( cmdRegOrData ) && !Array.isArray( inBytes ) ) {
		return this.i2cWriteReg( address, cmdRegOrData, inBytes );
	}

	// Only write if bytes provided
	while ( inBytes.length ) {
		var cp = CP.spawn( 'i2cset', [ '-y', '0', toHexString( cmdRegOrData ), toHexString( inBytes.shift() ) ] );
	}

	return this;
};

Omega2.prototype.i2cWriteReg = function( address, register, value ) {
	this.i2cConfig();

	var cp = CP.spawn( 'i2cset', [ '-y', '0', toHexString( address ), toHexString( register ), toHexString( value ) ] );

	return this;
};

Omega2.prototype._i2cRead = function( continuous, address, register, bytesToRead, callback ) {
	var data;
	var event = 'I2C-reply' + address + '-';

	this.i2cConfig();

	// Fix arguments if called with Firmata.js API
	if ( arguments.length === 4 && typeof register === 'number' && typeof bytesToRead === 'function' ) {
		callback = bytesToRead;
		bytesToRead = register;
		register = null;
	}

	register = register || 0;

	data = new Buffer( bytesToRead );

	callback = typeof callback === 'function' ?
		callback :
		function() {};

	event += register !== null ?
		register :
		0;

	var timeout = setTimeout( function read() {
		var afterRead = function( err, bytesRead, buffer ) {
			if ( err ) {
				return this.emit( 'error', err );
			}

			// Convert buffer to Array before emit
			this.emit( event, [].slice.call( buffer ) );

			if ( continuous && --bytesRead ) {
				setTimeout( read.bind( this ), _i2cPollDelay );
			}
		}.bind( this );

		this.once( event, callback );

		var args = [ '-y', '0', toHexString( address ), toHexString( register ) ];
		var cp = CP.spawn( 'i2cget', args );
		cp.on( 'data', function ( data ) {
			afterRead( null, 1, data );
		} );

	}.bind( this ), _i2cPollDelay );

	return this;
};

// this method supports both
// i2cRead(address, register, bytesToRead, handler)
// and
// i2cRead(address, bytesToRead, handler)
Omega2.prototype.i2cRead = function( address, register, bytesToRead, handler ) {
	return this
		._i2cRead
		.apply( this, [ true ].concat( [].slice.call( arguments ) ) );
};

// this method supports both
// i2cReadOnce(address, register, bytesToRead, handler)
// and
// i2cReadOnce(address, bytesToRead, handler)
Omega2.prototype.i2cReadOnce = function( address, register, bytesToRead, handler ) {
	return this
		._i2cRead
		.apply( this, [ false ].concat( [].slice.call( arguments ) ) );
};

var serialStates = {
	IDLE: 0,
	READING: 1,
	WRITING: 2,
	MESSAGE_RECIEVED: 3
};

Omega2.prototype.queryPinState = function( pinIndex, handler ) {
	var pin = this.pins[ pinIndex ];

	var event = [ 'change:pin.state' ];

	var cp = CP.spawn( 'fast-gpio', [ '-u', 'get-direction', pinIndex ] );
	cp.on('error', function (err) {
		return console.error( 'Error reading Omega2 pin ' + pinIndex, err );
	});
	cp.stdout.on( 'data', function( data ) {
		data = JSON.parse(data.toString());

		if (pin.mode !== data.val) {
			pin.mode = data.val == 'input' ? MODES.INPUT : MODES.OUTPUT;
			event.push( pin );
			this.emit.apply( this, event );
		}
	});
	cp.on( 'exit', function() {
		handler && handler( pin.mode );
	});

	return this;
};

Omega2.prototype.serialOpen = function( baudRate, channel ) {
	baudRate = baudRate || 115200;
	channel = channel || 0;
	address = '/dev/ttyS' + channel;

	// set the baud rate on the port
	CP.spawnSync( 'stty', [ '-F', address, baudRate ] );


	// open streams to sysfs node
	var readStream = FS.ReadStream( address );
	var writeStream = FS.WriteStream( address );

	this.serial[ channel ] = {
		address: address,
		baudRate: baudRate,
		parity: parity,
		stopBits: stopBits,
		channel: channel,
		buffer: [],
		readStream: readStream,
		writeStream: writeStream
	};
};

Omega2.prototype.serialClose = function( channel ) {
	channel = channel || 0;
	var serial = this.serial[ channel ];
	serial.readStream && serial.readStream.end();
	serial.writeStream && serial.writeStream.end();
	return this;
};

Omega2.prototype.serialListen = function( messageTerminator, channel ) {
	messageTerminator = messageTerminator || '\n';
	channel = channel || 0;

	var serial = this.serial[ channel ];
	serial.messageTerminator = messageTerminator;
	if ( serial.encoding !== encoding ) {
		serial.readStream.setEncoding( encoding );
	};

	serial.readStream.on( 'data', function( chunk ) {
		serial.buffer = serial.buffer.concat( Array.from( chunk ) );
		this.serialOnMessage( serial );
	} );
	return this;
};

Omega2.prototype.serialOnMessage = function( serialObject ) {
	while ( serialObject.indexOf( serialObject.messageTerminator ) > -1 ) {
		var termIndex = serialObject.indexOf( serialObject.messageTerminator );
		var message = buffer.splice( 0, termIndex + 1 );
		serialObject.message = message;
		this.emit( 'serial:message', serialObject );
	}
	return this;
};

Omega2.prototype.serialWrite = function( message, encoding, channel ) {
	channel = channel || 0;
	var serial = this.serial[ channel ];
	serial.writeStream.write( message, encoding );
	return this;
};

// Necessary for Firmata.js compatibility.
Omega2.prototype.sendI2CConfig = Omega2.prototype.i2cConfig;
Omega2.prototype.sendI2CReadRequest = Omega2.prototype.i2cReadOnce;
Omega2.prototype.sendI2CWriteRequest = Omega2.prototype.i2cWrite;

// Not Supported
[
	'analogRead',
	'pulseIn',
	'pulseOut',
	'_sendOneWireRequest',
	'_sendOneWireSearch',
	'sendOneWireWriteAndRead',
	'sendOneWireDelay',
	'sendOneWireDelay',
	'sendOneWireReset',
	'sendOneWireRead',
	'sendOneWireSearch',
	'sendOneWireAlarmsSearch',
	'sendOneWireConfig',
	'servoWrite',
	'stepperConfig',
	'stepperStep'
].forEach( function( method ) {
	Omega2.prototype[ method ] = function() {
		throw method + ' is not yet implemented.';
	};

} );

function defer() {
	var Promise = require('bluebird');

	var deferred = {};

	if (Promise != null) {
		new Promise( function( _resolve, _reject ) {
			deferred.resolve = _resolve;
			deferred.reject = _reject;
		} );
	}

	return deferred;
}

function toHexString( num ) {
	return '0x' + num.toString( 16 );
}

// Function omega2

Omega2.prototype.reboot = function() {
	CP.spawn('reboot');
};

Omega2.prototype.upgrade = function() {
	CP.spawn('oupgrade');
};

module.exports = Omega2;
