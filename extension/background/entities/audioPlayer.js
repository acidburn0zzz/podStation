'use strict';

/**
 * 
 * @typedef {Object} EpisodePlayerInfo
 * @property {EpisodeId} episodeId
 * @property {Object} audioTags
 */

(function(){
	angular
		.module('podstationBackgroundApp')
		.factory('audioBuilderService', audioBuilderService);
		
	function audioBuilderService() {
		const service = {
			buildAudio: buildAudio
		};

		return service;

		/**
		 * @param {string} audioUrl 
		 * @returns {HTMLAudioElement}
		 */
		function buildAudio(audioUrl) {
			return new Audio(audioUrl);
		};
	}
})();

(function(){
	angular
		.module('podstationBackgroundApp')
		.factory('audioPlayerService', ['$injector', '$interval', '$q', 'browser', 'messageService', 'storageService', 'audioBuilderService', 'podcastDataService', 'podcastStorageService', 'analyticsService', audioPlayerService]);

	function audioPlayerService($injector, $interval, $q, browserService, messageService, storageService, audioBuilderService, podcastDataService, podcastStorageService, _analyticsService) {
		/**
		 * @type {HTMLAudioElement}
		 */ 
		var audioPlayer;
		
		/** 
		 * @type {EpisodePlayerInfo}
		 */
		var episodeInfo;
		
		/**
		 * @type {Promise}
		 */
		var playingTimeOutID;
		var timeOutCounter = 0;

		const SYNC_OPTIONS = {
			'order':true,
			'continuous':true,
			'removeWhenFinished':true
		};

		function splitOptions(options) {
			const result = {
				local: {},
				sync: {}
			}

			for(var key in options) {
				result[SYNC_OPTIONS[key]?'sync':'local'][key] = options[key];
			}
			
			return result;
		}

		/**
		 * 
		 * @param {Array<Object>} allOptions 
		 */
		function mergeOptions(allOptions) {
			const result = {};

			allOptions.forEach((option) => {
				for(var key in option) {result[key] = option[key]}
			});

			return result;
		}

		function loadLocalPlayerOptions(loaded) {
			// loadPlayerOptions(browserService.storage.local, loaded);
			return storageService.loadFromStorage('playerOptions', loaded, 'local', () => {return {};});
		}

		function loadSyncPlayerOptions(loaded) {
			return storageService.loadFromStorage('playerOptions', (playerOptions) => {
				// handling of default values
				
				if(!playerOptions.order)
					playerOptions.order = 'from_podcast';
				
				if(typeof playerOptions.removeWhenFinished === 'undefined')
					playerOptions.removeWhenFinished = true;

				return loaded && loaded(playerOptions);
			}, 'sync', () => {return {};});
		};

		function getPodcastAndEpisode(episodeId) {
			return $injector.get('podcastManager').getPodcastAndEpisode(episodeId);
		}

		/**
		 * @returns {string}
		 */
		function imageUrl() {
			if(episodeInfo && episodeInfo.audioTags && episodeInfo.audioTags.imageDataUrl) {
				return episodeInfo.audioTags.imageDataUrl;
			}
			else if(episodeInfo) {
				var podcastAndEpisode = getPodcastAndEpisode(episodeInfo.episodeId);

				return podcastAndEpisode.podcast ? podcastAndEpisode.podcast.image : 'images/rss-alt-8x.png';
			}

			return undefined;
		}

		function showBrowserNotification(options) {
			switch(options.event) {
				case 'playing':
					browserService.notifications.clear('paused');
					break;
				case 'paused':
					browserService.notifications.clear('playing');
					break;
			}

			var podcastAndEpisode = getPodcastAndEpisode(episodeInfo.episodeId);

			browserService.notifications.create(options.event, {
				type: 'progress',
				iconUrl: imageUrl(),
				title: browserService.i18n.getMessage(options.event),
				message: podcastAndEpisode.episode.title,
				progress: Math.round(audioPlayer.duration ? ( audioPlayer.currentTime / audioPlayer.duration ) * 100 : 0)
			});
		}

		function getAudioTags(callback) {
			new jsmediatags.Reader(audioPlayer.src)
			.setTagsToRead(["PIC", "APIC"])
			.read({
				onSuccess: function(tag) {
					var tags = tag.tags;

					if( "picture" in tags ) {
						var image = tags.picture;
						var base64String = "";
						for (var i = 0; i < image.data.length; i++) {
								base64String += String.fromCharCode(image.data[i]);
						}

						tags.imageDataUrl = "data:" + image.format + ";base64," + window.btoa(base64String);

						callback(tags);
					}
				}
			});
		}

		function buildAudioInfo() {
			var podcastAndEpisode;
			
			podcastAndEpisode = episodeInfo ? getPodcastAndEpisode(episodeInfo.episodeId) : {};

			return {
				audio: {
					url: audioPlayer ? audioPlayer.src : '',
					imageUrl: imageUrl(),
					currentTime: audioPlayer ? audioPlayer.currentTime : 0,
					duration: audioPlayer ? audioPlayer.duration : 0,
					playbackRate: audioPlayer ? audioPlayer.playbackRate : 1.0,
					volume: audioPlayer ? audioPlayer.volume : 0,
					error: audioPlayer ? audioPlayer.error : 0,
					paused: audioPlayer.paused
				},
				episodeId: episodeInfo ? episodeInfo.episodeId : null
			}
		}

		function setEpisodeInProgress(episodeInfo, currentTime) {
			podcastStorageService.storeEpisodeUserData(episodeInfo.episodeId, {
				currentTime: currentTime
			});
		}

		function setCurrentTimeFromEpisode() {
			if(!episodeInfo) {
				return;
			}

			podcastStorageService.getEpisodeUserData(episodeInfo.episodeId).then(function(episodeUserData) {
				if(episodeUserData.currentTime >= 0 && Math.abs(episodeUserData.currentTime - audioPlayer.currentTime) > 20) {
					audioPlayer.currentTime = episodeUserData.currentTime;
				}
			});
		}

		function playingTimeOut() {
			messageService.for('audioPlayer').sendMessage('playing', { episodePlayerInfo: buildAudioInfo() });
			
			playingTimeOutID = $interval(function() {
				messageService.for('audioPlayer').sendMessage('playing', { episodePlayerInfo: buildAudioInfo() });

				timeOutCounter++;

				if(timeOutCounter === 10) {
					timeOutCounter = 0;
					setEpisodeInProgress(episodeInfo, audioPlayer.currentTime);
				}
			}, 1000);
		}

		function pauseTimeOut() {
			if(playingTimeOutID) {
				$interval.cancel(playingTimeOutID);
				playingTimeOutID = undefined;
				timeOutCounter = 0;
			}
		}

		function refresh() {
			// it will be cleared at the stop, so we need to 
			// save it here
			var playData = {
				episodeId: episodeInfo.episodeId
			}

			stop(true);
			play(playData);
		}

		function play(playData) {
			if(playData && playData.episodeId &&
				(!audioPlayer || !podcastDataService.episodeIdEqualsId(playData.episodeId, episodeInfo.episodeId ))
			) {
				if(audioPlayer) {
					audioPlayer.pause( );

					if(audioPlayer.currentTime	!= audioPlayer.duration) {
						setEpisodeInProgress(episodeInfo, audioPlayer.currentTime);
					}
				}

				var podcastAndEpisode = getPodcastAndEpisode(playData.episodeId);

				_analyticsService.trackEvent('audio', 'play_podcast_url', stripAuthFromURI(playData.episodeId.values.podcastUrl));
				audioPlayer = audioBuilderService.buildAudio(podcastAndEpisode.episode.enclosure.url);

				episodeInfo = { episodeId: playData.episodeId };

				loadLocalPlayerOptions(function(playerOptions) {
					audioPlayer.volume = playerOptions.volume ? playerOptions.volume : 1.0;
					messageService.for('audioPlayer').sendMessage('changed', { episodePlayerInfo: buildAudioInfo() });
				});

				audioPlayer.onended = onAudioEnded;
				audioPlayer.onerror = onAudioError;

				setCurrentTimeFromEpisode();

				getAudioTags(function(tags) {
					episodeInfo.audioTags = tags;
				});

				messageService.for('audioPlayer').sendMessage('changed', { episodePlayerInfo: buildAudioInfo() });

				addButtons();
			}

			if(audioPlayer.error) {
				audioPlayer.load();
				setCurrentTimeFromEpisode();
			}

			_analyticsService.trackEvent('audio', 'play');
			audioPlayer.play();

			if(playData && playData.showNotification) {
				showBrowserNotification({event: 'playing'});
			}

			// if we don't eliminate the timeout first we may have two timeouts
			// running in parallel (play while already playing)
			pauseTimeOut();
			playingTimeOut();

			browserService.browserAction.setBadgeText({
				text: '\u25B6' // play symbol
			});

			return;

			function onAudioEnded() {
				const currentEpisodeInfo = episodeInfo;

				_analyticsService.trackEvent('audio', 'ended');
				stop();

				loadSyncPlayerOptions(function(options) {
					if(options.removeWhenFinished) {
						messageService.for('playlist').sendMessage('remove', {
							episodeId: currentEpisodeInfo.episodeId
						});
					}

					if(options.continuous)
						playNextOrPrevious(true, currentEpisodeInfo);
				});
			};

			function onAudioError() {
				_analyticsService.trackEvent('audio', 'error');
				messageService.for('audioPlayer').sendMessage('changed', { episodePlayerInfo: buildAudioInfo() });
			}
		}

		function playNextOrPrevious(isNext, argEpisodeInfo) {

			if(isNext) {
				_analyticsService.trackEvent('audio', 'play_next');
			}
			else {
				_analyticsService.trackEvent('audio', 'play_prev');
			}

			const refEpisodeInfo = argEpisodeInfo ? argEpisodeInfo : episodeInfo;

			if(!refEpisodeInfo)
				return;

			loadSyncPlayerOptions(function(playerOptions) {
				$injector.get('podcastManager').getNextOrPreviousEpisode(isNext, playerOptions.order, refEpisodeInfo.episodeId, function(nextEpisodeId) {
					play({episodeId: nextEpisodeId});
				});

				return false;
			});
		}

		function pause(options) {
			_analyticsService.trackEvent('audio', 'pause');
			pauseTimeOut();
			audioPlayer.pause();

			if(options && options.showNotification) {
				showBrowserNotification({event: 'paused'});
			}

			setEpisodeInProgress(episodeInfo, audioPlayer.currentTime);
			messageService.for('audioPlayer').sendMessage('paused');

			browserService.browserAction.setBadgeText({
				text: '\u2759\u2759' // pause symbol
			});
		}

		function stop(keepProgress) {
			_analyticsService.trackEvent('audio', 'stop');

			pauseTimeOut();
			audioPlayer.pause();

			if(!keepProgress) {
				setEpisodeInProgress(episodeInfo, 0);
			}

			audioPlayer = undefined;
			episodeInfo = undefined;

			messageService.for('audioPlayer').sendMessage('stopped');

			browserService.browserAction.setBadgeText({
				text: ''
			});

			removeButtons();
		}

		function togglePlayPause() {
			if(!audioPlayer)
				return;

			if(audioPlayer.ended)
				return;

			if(audioPlayer.paused || audioPlayer.error) {
				play({ showNotification: true });
			}
			else {
				pause({ showNotification: true });
			}
		}

		messageService.for('audioPlayer')
		.onMessage('play', function(messageContent) {
			play(messageContent);
		}).onMessage('refresh', function() {
			refresh();
		}).onMessage('pause', function() {
			pause();
		}).onMessage('togglePlayPause', function() {
			togglePlayPause();
		}).onMessage('stop', function() {
			stop();
		}).onMessage('shiftPlaybackRate', function(messageContent) {
			if(audioPlayer && audioPlayer.playbackRate + messageContent.delta > 0) {
				audioPlayer.playbackRate += messageContent.delta;
				_analyticsService.trackEvent('audio', 'change_playback_rate', undefined, Math.round(100*audioPlayer.playbackRate));
			}
		}).onMessage('seek', function(messageContent) {
			if(audioPlayer && audioPlayer.duration) {
				_analyticsService.trackEvent('audio', 'seek');

				audioPlayer.currentTime = messageContent.position * audioPlayer.duration;

				setEpisodeInProgress(episodeInfo, audioPlayer.currentTime);

				messageService.for('audioPlayer').sendMessage('changed', { episodePlayerInfo: buildAudioInfo() });
			}
		}).onMessage('forward', function() {
			if(audioPlayer) {
				_analyticsService.trackEvent('audio', 'forward');

				const targetTime = audioPlayer.currentTime + 15;
				audioPlayer.currentTime = Math.min(audioPlayer.duration, targetTime);
				messageService.for('audioPlayer').sendMessage('changed', { episodePlayerInfo: buildAudioInfo() });
			}
		}).onMessage('backward', function() {
			if(audioPlayer) {
				_analyticsService.trackEvent('audio', 'backward');
				const targetTime = audioPlayer.currentTime - 15;
				audioPlayer.currentTime = Math.max(0, targetTime);
				messageService.for('audioPlayer').sendMessage('changed', { episodePlayerInfo: buildAudioInfo() });
			}
		}).onMessage('playNext', function() {
			playNextOrPrevious(true);
		}).onMessage('playPrevious', function() {
			playNextOrPrevious(false);
		}).onMessage('setVolume', function(message) {
			if(audioPlayer) {
				_analyticsService.trackEvent('audio', 'change_volume');

				audioPlayer.volume = message.value;

				loadLocalPlayerOptions(function(playerOptions) {
					playerOptions.volume = message.value;
					return playerOptions;
				});
			}
		}).onMessage('getAudioInfo', function(messageContent, sendResponse) {
			sendResponse(buildAudioInfo());
			return true;
		}).onMessage('getOptions', function(messageContent, sendResponse) {
			$q.all([loadSyncPlayerOptions(), loadLocalPlayerOptions()]).then((allOptions) => {
				sendResponse(mergeOptions(allOptions));
			});
			return true;
		}).onMessage('setOptions', function(messageContent) {
			const result = splitOptions(messageContent);

			$q.all([
				loadSyncPlayerOptions(function(options) {
					if(result.sync.order)
						options.order = result.sync.order;
	
					if(result.sync.continuous !== undefined)
						options.continuous = result.sync.continuous;
	
					if(result.sync.removeWhenFinished !== undefined)
						options.removeWhenFinished = result.sync.removeWhenFinished;
	
					return options;
				}),
				loadLocalPlayerOptions(function(options) {
					if(result.local.pauseOnLock)
						options.pauseOnLock = result.local.pauseOnLock;
	
					return options;
				})
			]).then((allOptions) => {
				messageService.for('audioPlayer').sendMessage('optionsChanged', mergeOptions(allOptions));
			});
		});

		messageService.for('podcastManager').onMessage('podcastSyncInfoChanged', function() {
			setCurrentTimeFromEpisode();
		});

		browserService.contextMenus.onClicked.addListener(function(info) {
			if(info.menuItemId === 'browser_action_play_pause') {
				_analyticsService.trackEvent('audio', 'play_pause_browser_action_button');
				togglePlayPause();
			}
		});

		browserService.commands.onCommand.addListener(function(command) {
			switch(command) {
				case 'play_pause':
					_analyticsService.trackEvent('audio', 'play_pause_hotkey');
					togglePlayPause();
					break;
			}
		});

		browserService.idle.onStateChanged.addListener((newState) => {
			
		});

		return {};

		function addButtons() {
			browserService.contextMenus.create({
				id: 'browser_action_play_pause',
				title: browserService.i18n.getMessage('play_pause'),
				contexts: ['browser_action'],
			});
		}

		function removeButtons() {
			browserService.contextMenus.remove('browser_action_play_pause');
		}

		function stripAuthFromURI(uri) {
			var parser = document.createElement('a');
			parser.href = uri;

			return parser.protocol + '//' + parser.host + parser.pathname + parser.search + parser.hash;
		}
	}
})();