var $E = function(selector, filter) {return ($(filter) || document).getElement(selector);};
var $ES = function(selector, filter) {return ($(filter) || document).getElements(selector);};

// make our client IDs such that they are always sorted *after* real,
// server-generated IDs ('z.') and they are chronologically sortable from each
// other. Also, append in the original cid() at the end for easier debugging.
//
// NOTE: *DO NOT* change the cid scheme without updating the cid_match regex
// below!
Composer.cid = (function() {
	var counter = 0;
	return function() {
		counter++;
		return ('000000000000' + new Date().getTime().toString(16)).substr(-12) +
			turtl.client_id +
			('0000' + (counter & 65535).toString(16)).substr(-4);
	};
})();

// keeps track of our db naming process
var dbname = function(api_url, user_id) { return 'turtl.server:'+api_url+',user:'+user_id; };

// 014d837656f10c160d0f98670a355bdfc69985137ab2a434d8995bc28027139cdb54310e29622253
var cid_match = /[0-9a-f]+/;
// 55553b952b137507650026a3
var old_id_match = /^[0-9a-f]{24}$/;

var default_route = '/';

var turtl = {
	client_id: null,

	site_url: null,

	events: new Composer.Event(),

	// holds the user model
	user: null,

	// holds the DOM object that turtl does all of its operations within
	main_container_selector: '#main',

	// global key handler for attaching keyboard events to the app
	keyboard: null,

	// a modal helper
	overlay: null,

	loaded: false,
	router: false,

	// holds the title breadcrumbs
	titles: [],

	controllers: {},

	controllers: {
		pages: null,
		header: null,
		nav: null,
		sidebar: null,
		loading: null
	},

	// some general libs we use
	router: null,
	api: null,
	back: null,

	// holds the last successfully routed url
	last_url: null,

	// -------------------------------------------------------------------------
	// Data section
	// -------------------------------------------------------------------------
	user: null,

	// holds messages for all the user's personas
	messages: null,

	// holds persona/board/note data for the user (ie, the user's profile)
	profile: null,

	// holds the search model
	search: null,

	// holds our sync model, responsible for coordinating synchronizing of data
	// between in-memory models, the local DB, and the API
	sync: null,

	// this is our local storage DB "server" (right now an IndexedDB abstraction
	// which stores files and notes locally).
	db: null,

	// holds our db-backed queue
	hustle: null,

	// Files collection, used to track file uploads/downloads
	files: null,
	// -------------------------------------------------------------------------

	init: function()
	{
		if(this.loaded) return false;

		turtl.user = new User();
		turtl.controllers.pages = new PagesController();
		turtl.controllers.header = new HeaderController();
		turtl.controllers.sidebar = new SidebarController();
		turtl.controllers.loading = new LoadingController();
		turtl.controllers.pages.bind('prerelease', function() {
			// always scroll to the top of the window on page load
			$(window).scrollTo(0, 0);
			turtl.events.trigger('header:set-actions', false);
		});

		turtl.events.bind('ui-error', function(msg, err) {
			barfr.barf(msg + ': ' + err.message);
		});

		turtl.keyboard = new TurtlKeyboard();
		turtl.keyboard.attach();

		turtl.overlay = new TurtlOverlay();

		var initial_route = window.location.pathname;
		turtl.setup_user({initial_route: initial_route});

		// if a user exists, log them in
		if(config.cookie_login)
		{
			this.user.login_from_cookie();
		}

		this.loaded = true;
		turtl.events.trigger('loaded');
		if(window.port) window.port.send('loaded');
		this.route(initial_route);

		var connect_barf_id = null;
		turtl.events.bind('api:connect', function() {
			log.info('API: connect');
			if(connect_barf_id) barfr.close_barf(connect_barf_id);
			connect_barf_id = barfr.barf('Connected to the Turtl service! Disengaging offline mode. Syncing your profile.');
		});
		turtl.events.bind('api:disconnect', function() {
			log.info('API: disconnect');
			if(connect_barf_id) barfr.close_barf(connect_barf_id);
			connect_barf_id = barfr.barf('Disconnected from the Turtl service. Engaging offline mode. Your changes will be saved and synced once back online!');
		});

		turtl.keyboard.bind('?', function() {
			if(!turtl.user.logged_in) return;
			//new KeyboardShortcutHelpController();
		});
	},

	setup_user: function(options)
	{
		options || (options = {});

		var load_profile = function()
		{
			// if the user is logged in, we'll put their auth info into the api object
			if(!window._disable_cookie)
			{
				turtl.user.bind('change', turtl.user.write_cookie.bind(turtl.user), 'user:write_changes_to_cookie');
			}
			turtl.controllers.pages.release_sub();
			turtl.sync = new Sync();
			turtl.profile = new Profile();
			turtl.search = new Search();
			turtl.files = new Files();
			turtl.user.get_auth().then(turtl.api.set_auth.bind(turtl.api))
			turtl.events.trigger('app:objects-loaded');

			turtl.show_loading_screen(true);
			turtl.update_loading_screen('Initializing Turtl');

			$E('body').removeClass('loggedout');

			// sets up local storage
			turtl.setup_local_db().bind({})
				.then(function() {
					this.start = new Date().getTime();
					return turtl.profile.load();
				})
				.then(function() {
					return turtl.setup_syncing();
				})
				.then(function() {
					log.info('profile: loaded in: ', (new Date().getTime()) - this.start);
					turtl.update_loading_screen('Indexing notes');
					return turtl.search.reindex();
				})
				.then(function() {
					setTimeout(turtl.show_loading_screen.bind(null, false), 200);
					turtl.controllers.pages.release_sub();
					turtl.controllers.nav = new NavController();
					var initial_route = options.initial_route || default_route;
					if(initial_route.match(/^\/users\//)) initial_route = default_route;
					if(initial_route.match(/index.html/)) initial_route = default_route;
					if(initial_route.match(/background.html/)) initial_route = default_route;
					var dont_initial_route = ['/users/join', '/personas/join'];
					if(!dont_initial_route.contains(turtl.router.cur_path()))
					{
						turtl.route(initial_route);
					}
					options.initial_route = '/';
					if(window.port) window.port.send('profile-load-complete');
					turtl.events.trigger('app:load:profile-loaded');

					turtl.keyboard.bind('n', turtl.route.bind(turtl, '/'), 'shortcut:main:notes');
					turtl.keyboard.bind('b', turtl.route.bind(turtl, '/boards'), 'shortcut:main:boards');
				})
				.catch(function(err) {
					barfr.barf('There was a problem with the initial load of your profile. Please try again.');
					log.error('turtl: load: ', derr(err));
					var what_next = new Element('div.choice');
					var retry = new Element('a')
						.set('href', '#retry')
						.addClass('button')
						.set('html', 'Retry')
						.inject(what_next);
					var logout = new Element('a')
						.set('href', '#logout')
						.addClass('button')
						.set('html', 'Logout')
						.inject(what_next);
					var wipe = new Element('a')
						.set('href', '#wipe')
						.addClass('button')
						.set('html', 'Clear local data')
						.inject(what_next);
					turtl.events.trigger('loading:stop');
					turtl.update_loading_screen(false);
					turtl.update_loading_screen('Error loading profile');
					turtl.update_loading_screen(what_next);
					retry.addEvent('click', function(e) {
						if(e) e.stop();
						turtl.update_loading_screen(false);
						load_profile();
					});
					logout.addEvent('click', function(e) {
						if(e) e.stop();
						turtl.user.logout();
					});
					wipe.addEvent('click', function(e) {
						var settings = new SettingsController();
						settings.wipe_data(e);
					});
				});

			// logout shortcut
			turtl.keyboard.bind('shift+l', function() {
				turtl.route('/users/logout');
			}, 'dashboard:shortcut:logout');
		}.bind(turtl);
		this.user.bind('login', load_profile);
		turtl.user.bind('logout', function() {
			turtl.user.key = null;
			turtl.user.auth = null;

			// stop syncing
			turtl.files.stop_syncing();
			turtl.sync.stop();

			$E('body').addClass('loggedout');

			turtl.controllers.pages.release_sub();
			if(turtl.controllers.nav) turtl.controllers.nav.release();
			turtl.keyboard.unbind('shift+l');
			turtl.keyboard.unbind('n', 'shortcut:main:notes');
			turtl.keyboard.unbind('b', 'shortcut:main:boards');
			turtl.show_loading_screen(false);
			turtl.user.unbind('change', 'user:write_changes_to_cookie');
			turtl.api.clear_auth();

			// local storage is for logged in people only
			if(turtl.db)
			{
				turtl.db.close();
				turtl.db = null;
			}

			// this should give us a clean slate
			turtl.profile.destroy();
			turtl.profile = null;
			turtl.search.wipe();
			turtl.search = null;
			turtl.files = null;

			turtl.route('/');

			turtl.events.trigger('user:logout');
			if(window.port) window.port.send('logout');
		}.bind(turtl));
	},

	setup_local_db: function()
	{
		return database.setup()
			.then(function(db) {
				turtl.db = db;
				turtl.events.trigger('db-init');
			})
			.then(function() {
				log.debug('turtl: hustle: create');
				var db_name = 'hustle:'+dbname(config.api_url, turtl.user.id());
				var hustle = new Hustle({
					tubes: ['files:download', 'files:upload'],
					db_name: db_name,
					db_version: 4,
					maintenance_delay: 5000
				});
				hustle.promisify();
				log.debug('turtl: hustle: open');
				return hustle.open()
					.then(function() {
						log.debug('turtl: hustle: opened');
						turtl.hustle = hustle;
					});
			})
	},

	wipe_local_db: function(options)
	{
		options || (options = {});

		if(!turtl.user.logged_in)
		{
			console.log('wipe_local_db only works when logged in. if you know the users ID, you can wipe via:');
			console.log('window.indexedDB.deleteDatabase("turtl.<userid>")');
			return false;
		}
		turtl.sync.stop();
		if(turtl.db) turtl.db.close();
		window.indexedDB.deleteDatabase(dbname(config.api_url, turtl.user.id()));
		if(turtl.hustle)
		{
			turtl.hustle.wipe();
		}
		else
		{
			window.indexedDB.deleteDatabase('hustle:'+dbname(config.api_url, turtl.user.id()));
		}
		turtl.db = null;
		turtl.hustle = null;
		if(options.restart)
		{
			return turtl.setup_local_db()
		}
		else
		{
			return Promise.resolve();
		}
	},

	loading: function(show)
	{
		return false;
	},

	setup_syncing: function()
	{
		// enable syncing
		turtl.sync.start();

		// register our tracking for local syncing (db => in-mem)
		//
		// NOTE: order matters here! since the keychain holds keys in its data,
		// it's important that it runs before everything else, or you may wind
		// up with data that doesn't get decrypted properly. next is the
		// personas, followed by boards, and lastly notes.
		turtl.sync.register_local_tracker('user', new Users());
		turtl.sync.register_local_tracker('keychain', turtl.profile.get('keychain'));
		turtl.sync.register_local_tracker('personas', turtl.profile.get('personas'));
		turtl.sync.register_local_tracker('boards', turtl.profile.get('boards'));
		turtl.sync.register_local_tracker('notes', turtl.profile.get('notes'));
		turtl.sync.register_local_tracker('files', turtl.files);
		turtl.sync.register_local_tracker('invites', turtl.profile.get('invites'));

		turtl.files.start_syncing();
	},

	stop_spinner: false,

	show_loading_screen: function(show, delay)
	{
		if(delay)
		{
			setTimeout(function() {
				turtl.events.trigger('loading:show', show);
			}, delay);
		}
		else
		{
			turtl.events.trigger('loading:show', show);
		}
	},

	update_loading_screen: function(msg)
	{
		turtl.events.trigger('loading:log', msg);
	},

	unload: function()
	{
		this.loaded = false;
		Object.each(this.controllers, function(controller) {
			controller.release();
		});
		this.controllers = {};
	},

	setup_router: function(options)
	{
		if(turtl.router) return;

		options || (options = {});
		options = Object.merge({
			base: config.route_base || '',
			// we'll do our own first route
			suppress_initial_route: true,
			default_title: 'Turtl',
			enable_cb: function(url) {
				var enabled = true;

				if(turtl.user.logged_in && (!turtl.profile || !turtl.profile.profile_data))
				{
					turtl.controllers.pages.trigger('loaded');
					enabled = false;
				}
				if(!turtl.loaded) enabled = false;
				return enabled;
			}
		}, options);
		turtl.router = new Composer.Router(config.routes, options);
		turtl.router.bind_links({
			filter_trailing_slash: true,
			selector: 'a:not([href^=#])'
		});

		// catch ALL #hash links and stop them in their tracks. this fixes a bug
		// in NWJS v0.15.x where setting the window location to a hash crashes
		// the app (at least in windows)
		Composer.add_event(document.body, 'click', function(e) {
			if(e) e.stop();
		}, 'a[href^="#"]');

		turtl.router.bind('route', turtl.controllers.pages.trigger.bind(turtl.controllers.pages, 'route'));
		turtl.router.bind('preroute', turtl.controllers.pages.trigger.bind(turtl.controllers.pages, 'preroute'));
		turtl.router.bind('fail', function(obj) {
			log.error('route failed:', obj.url, obj);
		});
		turtl.router.bind('preroute', function(boxed) {
			boxed.path = boxed.path.replace(/\-\-.*$/, '');
			return boxed;
		});

		// save turtl.last_url
		var route = null;
		turtl.router.bind('route', function() {
			turtl.last_url = route;
			turtl.last_clean_url = route ? route.replace(/\-\-.*/, '') : null;
			route = window.location.pathname;
		});
	},

	route: function(url, options)
	{
		options || (options = {});
		this.setup_router(options);
		if(
			!this.user.logged_in &&
			!url.match(/\/users\/login/) &&
			!url.match(/\/users\/join/)
		)
		{
			url = '/users/login';
		}
		this.router.route(url, options);
	},

	_set_title: function()
	{
		var title = 'Turtl';
		var back = false;
		if(turtl.titles[0])
		{
			title = turtl.titles[0].title;
			back = turtl.titles[0].back;
			options = turtl.titles[0].options;
		}

		turtl.controllers.header.render_title(title, back, options);
	},

	push_title: function(title, backurl, options)
	{
		if(!backurl) turtl.titles = turtl.titles.slice(0, 5);
		turtl.titles.unshift({
			title: title,
			back: backurl,
			options: options
		});
		turtl._set_title();
	},

	pop_title: function(do_route_back)
	{
		var entry = turtl.titles.shift()
		turtl._set_title();
		if(entry && entry.back && do_route_back)
		{
			var back = entry.back;
			turtl.route(entry.back);
		}
	},

	push_modal_url: function(url, options)
	{
		options || (options = {});

		var prefix = options.prefix || 'modal';
		var back = turtl.router.cur_path();
		var add = '--'+prefix+':'+url;
		if(options.add_url)
		{
			back = back.replace(add, '');
		}
		else
		{
			back = back.replace(/\-\-.*/, '');
		}
		back += add;
		turtl.route(back, {replace_state: options.replace});
		return function()
		{
			var re = new RegExp(add);
			if(!turtl.router.cur_path().match(re)) return;
			turtl.route(back.replace(re, ''));
		};
	}
};

var barfr = null;
var markdown = null;

var _turtl_init = function()
{
	// load the api URL from storage if it's there
	if(localStorage.config_api_url) config.api_url = localStorage.config_api_url;

	FastClick.attach(document.body);
	window.port = window.port || false;
	window._base_url = config.base_url || '';
	turtl.site_url = config.site_url || '';
	turtl.api = new Api(
		config.api_url,
		'',
		function(cb_success, cb_fail) {
			return function(data)
			{
				if(typeof(data) == 'string')
				{
					data = JSON.parse(data);
				}
				if(data.__error) cb_fail(data.__error);
				else cb_success(data);
			};
		}
	);

	// custom sizing per-device, mainly to make everything look exactly like it
	// does size-wise (in inches) on the iphone5. this is all made possible by
	// using rem font/box sizes everywhere instead of px...we can resize the
	// entire app in just one place.
	var font_size = 1;
	if(window.navigator.userAgent.match(/(DROID4|XT894)/)) font_size = 1.12;
	$E('html').setStyles({'font-size': font_size + 'px'});

	turtl.back = new Backstate();

	// create the barfr
	barfr = new Barfr('barfr', {timeout: 8000});

	// prevent backspace from navigating back
	$(document.body).addEvent('keydown', function(e) {
		if(e.key != 'backspace') return;
		var is_input = ['input', 'textarea'].contains(e.target.get('tag'));
		var is_editable = Composer.find_parent('div.editable', e.target);
		var is_button = is_input && ['button', 'submit'].contains(e.target.get('type'));
		if((is_input || is_editable) && !is_button) return;

		// prevent backspace from triggering if we're not in a form element
		e.stop();
	});

	marked.setOptions({
		renderer: new marked.Renderer(),
		gfm: true,
		tables: true,
		pedantic: false,
		sanitize: false,
		smartLists: true
	});

	view.fix_template_paths();

	var clid = localStorage.client_id;
	if(!clid) clid = localStorage.client_id = tcrypt.random_hash();
	turtl.client_id = clid;
	turtl.init();

	// set up workers for openpgp.js (if native crypto ain't available)
	openpgp.initWorker(asset('/library/openpgp/openpgp.worker.js'));

	setup_global_error_catching();
};

window.addEvent('domready', function() {
	setTimeout(_turtl_init, 100);
});

function setup_global_error_catching()
{
	// set up a global error handler that XHRs shit to the API so we know when bugs
	// are cropping up
	if(config.catch_global_errors)
	{
		var enable_errlog = true;
		var handler = function(msg, url, line)
		{
			if(!turtl.api || !enable_errlog) return;
			log.error('remote error log: ', arguments);
			// remove filesystem info
			url = url.replace(/^.*\/data\/app/, '/data/app');
			turtl.api.post('/log/error', {data: {client: config.client, version: config.version, msg: msg, url: url, line: line}})
				.catch(function(err) {
					log.error('error catcher: error posting (how ironic): ', derr(err));
					// error posting, disable log for 30s
					enable_errlog = false;
					(function() { enable_errlog = true; }).delay(30000);
				});
		};
		Promise.onPossiblyUnhandledRejection(function(err) {
			var msg = err.message;
			var parts = err.stack.split(/\n/g)[1].split(/:/, 2);
			var file = parts[0].replace(/at/, '').trim();
			var line = parts[1];
			handler(msg, file, line);
		});
		window.onerror = handler;
	}
}

