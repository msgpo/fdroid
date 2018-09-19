cordova.define("com.lyonbros.turtlstore.turtlstore", function(require, exports, module) {
var TurtlStore = (function() {
	var exec = function(action, args) {
		return new Promise(function(resolve, reject) {
			cordova.exec(
				function(res) {
					resolve(res);
				},
				function(err) {
					reject(err);
				},
				'TurtlStorePlugin',
				action,
				args
			);
		});
	};

	this.save = function(key) {
		return exec('save', [key]);
	};

	this.load = function() {
		return exec('load', []);
	};

	this.clear = function() {
		return exec('clear', []);
	};
});

module.exports = new TurtlStore();


});
