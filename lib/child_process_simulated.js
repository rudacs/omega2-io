'use strict';

var Emitter = require( 'events' ).EventEmitter;

function ChildProcessSimulated() {
  Emitter.call( this );

};

ChildProcessSimulated.prototype = Object.create(Emitter.prototype);

ChildProcessSimulated.prototype.spawn = function(command, opts) {

  if (opts) {
    for (var i = 0; i < opts.length; i++) {
      command += " " + opts[i];
    }
  }

  console.log(command);

  return new ChildProcessSimulatedRet();
};

function ChildProcessSimulatedRet() {
  Emitter.call( this );

  this.stdout = {
    on: function (ev, callback) {

    }
  }
}

ChildProcessSimulatedRet.prototype = Object.create(Emitter.prototype);

module.exports = new ChildProcessSimulated();
