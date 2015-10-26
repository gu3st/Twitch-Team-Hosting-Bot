// Referencing packages.
var async = require('async');
var moment = require('moment');
require('moment-duration-format');

// Referencing other files.
var loggingFuncs = require('./logging');
var globalVars = require('./global-vars');
var twitchAPI = require('./twitch-api');
var randomFuncs = require('./random');
var statsFuncs = require('./statistics');

// Starts the hosting (only will run if hosting is currently off).
exports.turnOnHosting = function(team) {
	if (!globalVars.active[team]) {
		globalVars.active[team] = true;
		chooseChannel(team);
		loggingFuncs.logMessage(team, 'The hosting bot has been turned on.');
		globalVars.client[team].say(globalVars.client[team].getUsername(), 'The hosting bot has been turned on.');
	}
}

// Stops the hosting (only will run if hosting is currently on).
exports.turnOffHosting = function(team) {
	if (globalVars.active[team]) {
		globalVars.active[team] = false;
		
		// Does the unhosting stuff on all the channels, if a channel is currenty hosted.
		// Needs to check if the unhost was successful really before printing the message.
		if (globalVars.currentHostedChannel[team]) {
			for (var i = 0; i < globalVars.channels[team].length; i++) {
				var lastHostedChannel = globalVars.currentHostedChannel[team];
				globalVars.client[team].unhost(globalVars.channels[team][i]);
				globalVars.client[team].say(globalVars.channels[team][i], 'We have stopped hosting ' + lastHostedChannel + '.');
			}
		}
		
		clearVariables(team);
		loggingFuncs.logMessage(team, 'The hosting bot has been turned off.');
		globalVars.client[team].say(globalVars.client[team].getUsername(), 'The hosting bot has been turned off.');
	}
}

// Used to host someone manually; they don't even have to be on the team!
exports.manuallyHostChannel = function(team, channel) {
	checkIfChannelExists(channel, function(exists, name) {
		if (!exists) {globalVars.client[team].say(globalVars.client[team].getUsername(), 'That channel doesn\'t exist.');}
		
		else {
			// Turns on the hosting bot if it wasn't on.
			if (!globalVars.active[team]) {
				globalVars.active[team] = true;
				loggingFuncs.logMessage(team, 'The hosting bot has been turned on.');
				globalVars.client[team].say(globalVars.client[team].getUsername(), 'The hosting bot has been turned on.');
			}
			
			chooseChannel(team, name);
		}
	});
}

// Chooses a channel from the team to host and hosts it.
function chooseChannel(team, channel) {
	var chosenChannel = channel;
	
	async.waterfall([
		function(callback) {
			// If a channel hasn't been specified manually, finds one on the team.
			if (!chosenChannel) {
				getOnlineChannels(team, function(onlineChannels) {
					// If the current hosted channel is still online, removes it from the online channels list.
					for (var i = 0; i < onlineChannels.length; i++) {
						if (onlineChannels[i].username === globalVars.currentHostedChannel[team]) {
							onlineChannels.splice(i, 1);
							break;
						}
					}
					
					// If there are channels online to host...
					if (onlineChannels.length > 0) {
						// Only 1 channel online, chooses this by default.
						if (onlineChannels.length === 1) {chosenChannel = onlineChannels[0].username;}
						
						// More than 1...
						else {
							var channelsToChoose = [];
							
							// Gets a list of channels playing a preferred game.
							for (var i = 0; i < onlineChannels.length; i++) {
								for (var j = 0; j < globalVars.preferredGames[team].length; j++) {
									if (onlineChannels[i].currentGame && onlineChannels[i].currentGame.toLowerCase().indexOf(globalVars.preferredGames[team][j].toLowerCase()) >= 0) {
										channelsToChoose.push(onlineChannels[i]);
										break;
									}
								}
							}
							
							// If no channels are playing preferred games, anyone can be hosted.
							if (channelsToChoose.length == 0) {channelsToChoose = onlineChannels;}
							
							var random = randomFuncs.randomInt(0, channelsToChoose.length);
							chosenChannel = channelsToChoose[random].username;
						}
					}
					
					// No channel online to pick from.
					else {chosenChannel = null;}
					
					callback();
				});
			}
			
			else {callback();}
		}
	], function(err) {
		if (chosenChannel) {
			// Logs a message for the last hosted channel, if there was one.
			if (globalVars.currentHostedChannel[team]) {
				loggingFuncs.logMessage(team, 'Stopped hosting ' + globalVars.currentHostedChannel[team] + ' (hosted for ' + exports.calculateHostedTime(team) + ').');
			}
			
			clearVariables(team);
			globalVars.currentHostedChannel[team] = chosenChannel;
			globalVars.hostStartTime[team] = moment.utc();
			globalVars.timeouts[team] = setTimeout(function() {chooseChannel(team);}, globalVars.hostLength);
			checkIfOffline(team);
			statsFuncs.incrementChannelStat(team, chosenChannel);
			loggingFuncs.logMessage(team, 'Started hosting ' + chosenChannel + '.');
			
			getOfflineChannels(globalVars.channels[team], function(offlineChannels) {
				// Does the hosting stuff on all the offline channels.
				// Needs to check if the host was successful really before printing the message.
				for (var i = 0; i < offlineChannels.length; i++) {
					globalVars.client[team].host(offlineChannels[i], chosenChannel);
					globalVars.client[team].say(offlineChannels[i], 'We have started hosting ' + chosenChannel + '.');
				}
			});
		}
		
		else {
			// Checks again after a while (will continue to host the current channel if one is hosted).
			globalVars.timeouts[team] = setTimeout(function() {chooseChannel(team);}, globalVars.recheckLength);
		}
	});
}

// Gets the online channels for the specific team.
function getOnlineChannels(team, callback) {
	twitchAPI.getTeamLiveChannels(team, function(error, errorType, response) {
		if (!error) {
			var onlineChannels = [];
			
			for (var i = 0; i < response.channels.length; i++) {
				// Uses the display name if available.
				var name = response.channels[i].channel.display_name;
				if (!name) {name = response.channels[i].channel.name;}
				
				onlineChannels.push({
					username: name,
					currentGame: response.channels[i].channel.meta_game,
					currentViewers: response.channels[i].channel.current_viewers
				});
			}
			
			callback(onlineChannels);
		}
	});
}

// Gets the offline channels for an array of channels.
function getOfflineChannels(channels, callback) {
	twitchAPI.getStreamStatus(channels, function(error, errorType, response) {
		if (!error) {
			var onlineChannels = [];
			var offlineChannels = [];
			
			// Put all online channel names into an array.
			for (var i = 0; i < response.streams.length; i++) {onlineChannels.push(response.streams[i].channel.name);}
			
			// Checks which channels are offline right now.
			for (var i = 0; i < channels.length; i++) {
				if (onlineChannels.indexOf(channels[i].toLowerCase()) < 0) {
					offlineChannels.push(channels[i]);
				}
			}
			
			callback(offlineChannels);
		}
	});
}

// Checks if a channel exists, according to Twitch's API.
// Also returns their name/display name for ease of use.
function checkIfChannelExists(channel, callback) {
	twitchAPI.getChannelData(channel, function(error, errorType, response) {
		if (error) {callback(false);}
		
		else {
			var name = response.display_name;
			if (!name) {name = response.name;}
			callback(true, name);
		}
	});
}

// Used to check if the host target goes offline.
function checkIfOffline(team) {
	var detectedOffline = false;
	
	globalVars.client[team].on('notice', globalVars.offlineNotice[team] = function(channel, msgid, message) {
		// Checks any of the channels we are connected to, to see if our target goes offline.
		if (!detectedOffline && msgid === 'host_target_went_offline'
			&& message.toLowerCase().indexOf(globalVars.currentHostedChannel[team].toLowerCase()) === 0) {
			loggingFuncs.logMessage(team, 'Stopped hosting ' + globalVars.currentHostedChannel[team] + ' (went offline, hosted for ' + exports.calculateHostedTime(team) + ').');
			detectedOffline = true;
			clearVariables(team);			
			chooseChannel(team);
		}
	});
}

// Clears out some global variables for the specified team.
function clearVariables(team) {
	globalVars.currentHostedChannel[team] = null;
	globalVars.hostStartTime[team] = null;
	clearTimeout(globalVars.timeouts[team]);
	
	if (globalVars.offlineNotice[team]) {
		globalVars.client[team].removeListener('notice', globalVars.offlineNotice[team]);
		globalVars.offlineNotice[team] = null;
	}
}

// Used to calculate the time the current hosted channel for the team has been hosted for.
exports.calculateHostedTime = function(team) {
	// If hosted time is null, returns a 0 instead (although this shouldn't happen!).
	if (!globalVars.hostStartTime[team]) {return '0s';}
	
	var hostedTimeInSecs = moment.utc().diff(globalVars.hostStartTime[team], 'seconds');
	var hostedTime = moment.duration(hostedTimeInSecs, 'seconds');
	hostedTime = hostedTime.format('h:mm:ss');
	if (hostedTimeInSecs < 60) {return hostedTime + 's';}
	else {return hostedTime;}
}