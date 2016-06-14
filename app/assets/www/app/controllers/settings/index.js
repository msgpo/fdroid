var SettingsController = Composer.Controller.extend({
	class_name: 'settings',

	events: {
		'click a[href=#wipe]': 'wipe_data'
	},

	init: function()
	{
		turtl.push_title('Your settings');
		this.bind('release', turtl.pop_title.bind(null, false));

		this.render();
	},

	render: function()
	{
		this.html(view.render('settings/index', {
			version: config.client + '-' + config.version
		}));
	},

	wipe_data: function(e)
	{
		if(e) e.stop();

		var promise = Promise.resolve([]);
		if(turtl.db && turtl.db.sync_outgoing)
		{
			var promise = turtl.db.sync_outgoing.query().all().execute().bind(this)
		}
		promise
			.then(function(res) {
				var outgoing_msg = '';
				if(res.length > 0)
				{
					outgoing_msg = ', however you have '+res.length+' changes waiting to be synced that will be lost if you do this';
				}
				if(!confirm('This will erase all your local data and log you out. Your profile will be downloaded again next time you log in'+ outgoing_msg +'. Continue?'))
				{
					return;
				}
				return turtl.wipe_local_db()
					.then(function() { return turtl.user.logout(); })
			})
			.catch(function(err) {
				turtl.events.trigger('ui-error', 'There was a problem clearing your profile', err);
				log.error('settings: wipe db: ', derr(err));
			});
	}
});

