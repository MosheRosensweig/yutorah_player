// page init
jQuery(function () {
	initTogglePopup();
	initTabs();
	jcf.customForms.replaceAll();
	initDafAutoComplete();
	//initSlideShow();	// now called after dynamic load from /js/loadData.js
	//initCarousel();	// now called after dynamic load from /js/loadData.js
	initPopups();
	initSameHeight();
	initChildClasses();
	jQuery('input, textarea').placeholder();
	initFixedPositionNav();
	initAddClassBottom();
});

jQuery(window).load(function () {
	initClearInput();
	// 5/13/2016
	//initTouchNav();
	jQuery('.main-holder').each(function () {
		jQuery(this).trigger('fakeResize');
	});
});

// Remove the jcf plugin from the daf page and attach the select2 plugin
function initDafAutoComplete() {
	var masechtaSelect = $('#masechtaSelect');
	var dafSelect = $('#dafSelect');
	var contactSelect = $('#contactType');
	if (masechtaSelect.length > 0 && dafSelect.length > 0) {
		jcf.customForms.destroy(masechtaSelect.get(0));
		jcf.customForms.destroy(dafSelect.get(0));
		masechtaSelect.removeAttr('style');
		masechtaSelect.select2();
		dafSelect.removeAttr('style');
		dafSelect.select2();
	}
	if (contactSelect.length > 0) {
		jcf.customForms.destroy(contactSelect.get(0));
		contactSelect.removeAttr('style');
	}
}

function initAddClassBottom() {
	var win = jQuery(window);
	var holder = jQuery('#wrapper');
	var scrollTop;
	var body = jQuery('body');
	positionFlag = true;

	function scrollHandler() {
		if (jQuery('#wrap-holder').scrollTop() > holder.outerHeight(true) / 2) {
			if (positionFlag) {
				positionFlag = false;
				body.addClass('scroll-at-bottom');
			}
		} else {
			if (!positionFlag) {
				positionFlag = true;
				body.removeClass('scroll-at-bottom');
			}
		}
	}

	win.on('load resize orientationchange', function () {
		scrollHandler();
	});
	jQuery('#wrap-holder').on('scroll', function () {
		scrollHandler();
	});
}

function initFixedPositionNav() {
	var win = jQuery(window);
	var scrollHolder = jQuery('#wrap-holder');

	var isMobileView = win.width() < 1024;

	if (isMobileView) {
		jQuery('.nav1 .side-nav-holder .sidenav').each(function () {
			var box = jQuery(this);
			var scrollTop;
			var fixedPosition = parseInt(box.css('top'));

			setTop();
			function setTop() {
				box.css({
					top: "95px",
					marginTop: Math.max(-parseInt(box.css('top')), -scrollHolder.scrollTop()),
					background: "linear-gradient(to bottom,rgba(72,87,112,1) 0,rgba(71,86,111,1) 2%,rgba(87,106,135,1) 40%,rgba(87,106,136,1) 100%)"
				});
			}

			win.on('load resize orientationchange', setTop);
			scrollHolder.on('scroll', setTop);
		});
	} else {
		jQuery('.nav1').each(function () {
			var box = jQuery(this);
			var scrollTop;
			var fixedPosition = parseInt(box.css('top'));

			setTop();
			function setTop() {
				box.css({
					marginTop: Math.max(-parseInt(box.css('top')), -scrollHolder.scrollTop()),
				});
			}

			win.on('load resize orientationchange', setTop);
			scrollHolder.on('scroll', setTop);
		});
	}
}

(function ($) {
	function TogglePopup(options) {
		this.options = $.extend({
			activeClass: 'body-active-top',
			linkActiveClass: 'menu-active',
			links: '>li>a',
			skipClass: 'skip'
		}, options);
		this.init();
	}
	TogglePopup.prototype = {
		init: function () {
			if (this.options.holder) {
				this.findElements();
				this.attachEvents();
			}
		},
		findElements: function () {
			this.holder = $(this.options.holder);
			this.links = this.holder.find(this.options.links).not('.' + this.options.skipClass);
			this.body = $('body');
		},
		attachEvents: function () {
			var self = this;

			this.toggleHandler = function (e) {
				e.preventDefault();
				self.toggleState($(this));
			}

			this.outsideClickHandler = function (e) {
				if (!$(e.target).closest(self.holder).length && !$(e.target).closest('.detail-box').length || $(e.target).hasClass(self.options.skipClass)) {
					self.hide();
				}
			}

			$(document).off('click', this.outsideClickHandler);
			this.links.on('click', this.toggleHandler)
		},
		toggleState: function (link) {
			var activeLink = this.links.parent().filter('.' + this.options.linkActiveClass).children();

			if (activeLink.is(link)) {
				if (!activeLink.parent().hasClass(this.options.linkActiveClass)) {
					link.addClass(this.options.linkActiveClass);
					this.show();
				} else {
					activeLink.parent().removeClass(this.options.linkActiveClass);
					this.hide();
				}
			} else {
				this.links.parent().removeClass(this.options.linkActiveClass)
				if (!link.hasClass(this.options.linkActiveClass)) {
					link.parent().addClass(this.options.linkActiveClass);
					this.show();
				} else {
					link.parent().removeClass(this.options.linkActiveClass);
					this.hide();
				}
			}
		},
		show: function () {
			this.body.addClass(this.options.activeClass);
			$(document).on('click', this.outsideClickHandler);
		},
		hide: function () {
			this.body.removeClass(this.options.activeClass);
			this.links.parent().removeClass(this.options.linkActiveClass);
			$(document).off('click', this.outsideClickHandler);
			this.makeCallback('onHide', true);
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				this.options[name].apply(this, args);
			}
		}
	}

	$.fn.togglePopup = function (opt) {
		return this.each(function () {
			$(this).data('TogglePopup', new TogglePopup($.extend({ holder: this }, opt)));
		});
	}
}(jQuery));

// toggle popup init
function initTogglePopup() {
	jQuery('.sidenav > ul').togglePopup({
		onHide: function () {
			var self = this;

			jQuery('body').removeClass('aside-active');
			setTimeout(function () {
				if (self.links.closest('li').filter('.popup-active').length) {
					self.links.closest('li').filter('.popup-active').removeClass('popup-active');
				}
			}, 10);
		}
	});

}

function initClearInput() {

	jQuery('.search-form').each(function () {
		var searchForm = jQuery(this);
		var input = searchForm.find('.autocomplete-input');
		var btnClear = searchForm.find('.close');
		btnClear.hide();

		input.on('keyup', function () {
			if (input.val().length) {
				btnClear.show();
			} else {
				btnClear.hide();
			}
		});

		btnClear.on('click', function (e) {
			e.preventDefault();
			input.val('');
			btnClear.hide();
		});
	});

}

// Simple Mobile Navigation
(function ($) {
	function MobileNav(options) {
		this.options = $.extend({
			container: null,
			hideOnClickOutside: true,
			menuActiveClass: 'nav-active',
			menuOpener: '.nav-opener',
			menuDrop: '.nav-drop',
			toggleEvent: 'click',
			outsideClickEvent: 'click touchstart pointerdown MSPointerDown'
		}, options);
		this.initStructure();
		this.attachEvents();
	}
	MobileNav.prototype = {
		initStructure: function () {
			this.page = $('html');
			this.container = $(this.options.container);
			this.opener = this.container.find(this.options.menuOpener);
			this.drop = this.container.find(this.options.menuDrop);
		},
		attachEvents: function () {
			var self = this;

			if (activateResizeHandler) {
				activateResizeHandler();
				activateResizeHandler = null;
			}

			this.outsideClickHandler = function (e) {
				if (self.isOpened()) {
					var target = $(e.target);
					if (!target.closest(self.opener).length && !target.closest(self.drop).length) {
						self.hide();
					}
				}
			};

			this.openerClickHandler = function (e) {
				e.preventDefault();
				self.toggle($(this));
			};

			this.opener.on(this.options.toggleEvent, this.openerClickHandler);
		},
		isOpened: function () {
			return this.container.hasClass(this.options.menuActiveClass);
		},
		show: function (opener) {
			this.container.addClass(this.options.menuActiveClass);
			if (this.options.hideOnClickOutside) {
				this.page.on(this.options.outsideClickEvent, this.outsideClickHandler);
			}
			opener.parent().addClass('menu-active');
			this.makeCallback('onShow', opener);
		},
		hide: function () {
			this.container.removeClass(this.options.menuActiveClass);
			if (this.options.hideOnClickOutside) {
				this.page.off(this.options.outsideClickEvent, this.outsideClickHandler);
			}
			this.opener.parent().removeClass('menu-active');
			this.makeCallback('onHide', true);
		},
		toggle: function (opener) {
			if (this.isOpened()) {
				this.hide();
			} else {
				this.show(opener);
			}
		},
		destroy: function () {
			this.container.removeClass(this.options.menuActiveClass);
			this.opener.off(this.options.toggleEvent, this.clickHandler);
			this.page.off(this.options.outsideClickEvent, this.outsideClickHandler);
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				this.options[name].apply(this, args);
			}
		}
	};

	var activateResizeHandler = function () {
		var win = $(window),
			doc = $('html'),
			resizeClass = 'resize-active',
			flag, timer;
		var removeClassHandler = function () {
			flag = false;
			doc.removeClass(resizeClass);
		};
		var resizeHandler = function () {
			if (!flag) {
				flag = true;
				doc.addClass(resizeClass);
			}
			clearTimeout(timer);
			timer = setTimeout(removeClassHandler, 500);
		};
		win.on('resize orientationchange', resizeHandler);
	};

	$.fn.mobileNav = function (options) {
		return this.each(function () {
			var params = $.extend({}, options, { container: this }),
				instance = new MobileNav(params);
			$.data(this, 'MobileNav', instance);
		});
	};
}(jQuery));

// scroll galleries init
function initCarousel() {
	jQuery('.slider').scrollGallery({
		mask: 'div.mask',
		slider: 'div.slideset',
		slides: 'div.slide',
		btnPrev: 'a.btn-prev',
		btnNext: 'a.btn-next',
		pagerLinks: '.pagination li',
		maskAutoSize: true,
		autoRotation: true,
		switchTime: 3000,
		animSpeed: 500,
		step: 1
	});
	jQuery('.tabset').scrollGallery({
		mask: 'div.mask',
		slider: 'div.slideset',
		slides: 'div.slide',
		btnPrev: 'a.btn-prev',
		btnNext: 'a.btn-next',
		autoRotation: false,
		switchTime: 3000,
		animSpeed: 500,
		step: 1,
		onInit: function () {
			var self = this;

			this.slides.on('click', function () {
				switchHandler(jQuery(this))
			});

			if (this.slides.length) {
				switchHandler(this.slides.find('a').filter('.' + this.options.activeClass))
			}

			function switchHandler(slide) {
				if (slide.offset().left + slide.outerWidth() > self.mask.offset().left + self.mask.outerWidth()) {
					self.slider.animate({
						marginLeft: parseInt(self.slider.css('margin-left')) - (slide.offset().left + slide.outerWidth() - self.mask.offset().left - self.mask.outerWidth())
					}, self.animSpeed);
					self.currentStep = slide.index();
				}
				if (slide.offset().left < self.mask.offset().left) {
					self.slider.animate({
						marginLeft: parseInt(self.slider.css('margin-left')) - slide.offset().left + self.mask.offset().left
					}, self.animSpeed);
					self.currentStep = slide.index();
				}
			}
		}
	});
}

function slideShowHeight() {
	setTimeout(function () {
		jQuery('.slideshow > .slideset').css('min-height', '100%');
	}, 5000);
}
// fade gallery init
function initSlideShow() {
	jQuery('.slideshow').fadeGallery({
		slides: 'div.slide',
		btnPrev: 'a.btn-prev',
		btnNext: 'a.btn-next',
		pagerLinks: '.pagination li',
		event: 'click',
		useSwipe: true,
		autoRotation: true,
		autoHeight: true,
		switchTime: 4500,
		animSpeed: 500,
		makeCallback: slideShowHeight()
	});
}

// content tabs init
function initTabs() {
	jQuery('.js-tabset').contentTabs({
		tabLinks: 'a'
	});
}

// open-close init
function initOpenClose() {
	var isTouchDevice = (/MSIE 10.*Touch/.test(navigator.userAgent)) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch,
		isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent)
	var event = isTouchDevice ? (isWinPhoneDevice ? 'click' : 'touchend') : 'click';

	jQuery('.queue-panel .block').openClose({
		activeClass: 'active',
		hideOnClickOutside: true,
		opener: '.textbox, .status-bar',
		slider: '.detail',
		animSpeed: 400,
		event: event,
		customFlag: true,
		effect: 'slide',
		animStart: function () {
			jQuery('.sidenav li.articles').data('ContentPopup').hidePopup();
		}
	});
	jQuery('.sidenav .tab-content .textbox').openClose({
		activeClass: 'active',
		opener: '.opener-box',
		slider: '.slide',
		animSpeed: 400,
		effect: 'slide',
		event: event,
	});
	jQuery('.dropdown-subscribe').openClose({
		hideOnClickOutside: true,
		activeClass: 'active',
		opener: '.opener',
		slider: '.drop',
		animSpeed: 400,
		effect: 'none'
	});
	/*jQuery('.social-networks-holder').openClose({
		hideOnClickOutside: true,
		activeClass: 'active',
		opener: '.share',
		slider: '.social-networks',
		animSpeed: 400,
		effect: 'none'
	});*/
	jQuery('.lecture-page .social-networks-holder').openClose({
		hideOnClickOutside: true,
		activeClass: 'active',
		opener: '.share',
		slider: '.social-networks',
		animSpeed: 400,
		effect: 'none'
	});
	jQuery('.social-holder').openClose({
		hideOnClickOutside: true,
		activeClass: 'active',
		opener: '.more',
		slider: '.social-frame',
		animSpeed: 400,
		effect: 'none'
	});
	jQuery('.add-nav li').openClose({
		activeClass: 'active',
		opener: '.opener, .filter-title-opener',
		slider: '.slide',
		animSpeed: 400,
		effect: 'slide'
	});
	/*
  jQuery('.filter-result .holder').openClose({
		activeClass: 'active',
		opener: '.more-info',
		slider: '.post',
		animSpeed: 400,
		effect: 'slide'
	});
  */
	/*
	  jQuery('.filter-result>li').openClose({
		  activeClass: 'active-state',
		  opener: '.more',
		  slider: '.more-results',
		  animSpeed: 400,
		  effect: 'slide'
	  });
	*/
	// 8/10/2015 Alex  - disable the filter box layout for smaller resolution
	/*ResponsiveHelper.addRange({
	  '767..': {
		on: function() {
		  jQuery('#main').openClose({
			activeClass: 'active',
			opener: '.filter',
			slider: '.filter-form-2',
			animSpeed: 400,
			effect: 'none'
		  });
		},
		off: function() {
		  if(jQuery('#main').data('OpenClose')) {
			jQuery('#main').data('OpenClose').destroy();
		  }
		}
	  }
	});*/
	ResponsiveHelper.addRange({
		'..1023': {
			on: function () {
				jQuery('.nav-holder, .form-box').openClose({
					hideOnClickOutside: true,
					activeClass: 'active',
					opener: '.opener',
					slider: '.slide',
					animSpeed: 400,
					effect: 'none',
					onInit: function () {
						var self = this;
						var win = jQuery(window);

						win.on('resize orientationchange', function () {
							if (self.holder.hasClass(self.options.activeClass) && win.width() < 1024) {
								jQuery('body').addClass('item-active');
							}
						});
					},
					onBeforeShow: function () {
						var self = this;

						jQuery('.form-box, .nav-holder').each(function () {
							var holder = jQuery(this);

							if (holder.is(self.holder)) return;

							if (holder.data('OpenClose') && holder.hasClass(self.options.activeClass)) {
								holder.data('OpenClose').hideSlide();
							}
						});
						jQuery('body').addClass('item-active');
					},
					onBeforeHide: function () {
						jQuery('body').removeClass('item-active');
					}
				});
			},
			off: function () {
				jQuery('.nav-holder, .form-box').each(function () {
					var holder = jQuery(this);

					if (holder.data('OpenClose')) {
						holder.data('OpenClose').destroy();
					}
					jQuery('body').removeClass('item-active');
				});
			}
		}
	});
}

// popups init
function initPopups() {
	jQuery('.articles').contentPopup({
		mode: 'click',
		btnOpen: '.opener-sidenav',
		hideOnClickLink: false,
		popup: '.articles-popup'
	});

	return;
	var sidebarTimer;
	var body = jQuery('body');
	var activeClass = 'aside-active';
	var animateHideClass = 'animate-hide';
	var isTouchDevice = (/MSIE 10.*Touch/.test(navigator.userAgent)) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;
	var wrapper = jQuery('#wrapper');
	//var pageHolder = jQuery('<div class="page-anim-holder">');
	//var pageWrap = jQuery('<div class="page-anim-wrap">');
	var initClass = 'init-active';

	/*jQuery('.sidenav .tab-content .textbox').contentPopup({
		mode: 'click',
		popup: '.detail-box'
	});*/
	jQuery('.articles').contentPopup({
		mode: 'click',
		popup: '.articles-popup'
	});

	ResponsiveHelper.addRange({
		'..1023': {
			on: function () {
				mobileInit();
			},
			off: function () {
				mobileDestroy();
			}
		},
		'1024..': {
			on: function () {
				desktopInit();
			},
			off: function () {
				desktopDestroy();
			}
		}
	});

	function desktopDestroy() {
		if (body.hasClass(activeClass)) {
			body.removeClass(activeClass);
			pageHolder.unwrap();
			wrapper.unwrap();
		}
		jQuery('.sidenav > ul > li').each(function () {
			var popup = jQuery(this);

			if (popup.data('ContentPopup')) {
				popup.data('ContentPopup').destroy();
			}
		});
	}

	function mobileDestroy() {
		jQuery('.sidenav > ul > li').each(function () {
			var popup = jQuery(this);

			if (popup.data('ContentPopup')) {
				popup.data('ContentPopup').destroy();
			}
		});
	}

	function desktopInit() {
		jQuery('.sidenav > ul > li').contentPopup({
			mode: 'click',
			popup: '.queue-panel',
			btnOpen: '.opener',
			openClass: 'active',
			hideOnClickOutside: true,
			exceptionBlock: '.detail-box',
			onShowPopup: function (that) {
				setTimeout(function () {
					wrapper.wrap(pageWrap).wrap(pageHolder);
					setTimeout(function () {
						body.addClass(activeClass);
					}, 1)
				}, 1);
			},
			onHidePopup: function () {
				body.addClass(animateHideClass);
				body.removeClass(activeClass);
				body.addClass(initClass);
				setTimeout(function () {
					jQuery('.detail-box').remove();
					jQuery('#main').css({ height: '' })
					initSameHeight();
					body.removeClass(animateHideClass);
					body.removeClass(initClass);
					wrapper.unwrap().unwrap();
					jQuery('.main-holder').each(function () {
						jQuery(this).trigger('fakeResize');
					});
				}, 500);
			}
		});
	}

	function mobileInit() {
		jQuery('.sidenav > ul > li').contentPopup({
			mode: 'click',
			popup: '.queue-panel',
			btnOpen: '.opener',
			openClass: 'active',
			hideOnClickOutside: true,
			// exceptionBlock:'.detail-box',
			onShowPopup: function (that) {
				setTimeout(function () {
					body.addClass(activeClass);
				}, 1)
			},
			onHidePopup: function () {
				body.removeClass(activeClass);
			}
		});
	}
}

// align blocks height
function initSameHeight() {
	// jQuery('.twocolumns').sameHeight({
	// 	elements: '.same',
	// 	flexible: true,
	// 	multiLine: true
	// });
	/* jQuery('.main-holder').sameHeight({
		 elements: '#content, #sidebar',
		 flexible: true,
		 multiLine: true
	 });*/
	jQuery('.sidenav').sameHeight({
		elements: '.sidenav li',
		flexible: true,
		multiLine: true
	});
}

// handle dropdowns on mobile devices
function initTouchNav() {
	// jQuery('.sidenav').each(function(){
	// new TouchNav({
	// navBlock: this,
	// menuDrop: 'div'
	// });
	// });
	var isTouchDevice = (/MSIE 10.*Touch/.test(navigator.userAgent)) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;
	if (!isTouchDevice) {
		jQuery('#nav').each(function () {
			new TouchNav({
				navBlock: this,
				menuItems: 'li',
				menuOpener: 'a',
				menuDrop: '.js-drop'
			});
		});
		jQuery('.dropdown').each(function () {
			new TouchNav({
				navBlock: this,
				menuDrop: 'div'
			});
		});
	}
	jQuery('.frame').each(function () {
		new TouchNav({
			navBlock: this,
			menuOpener: '.post',
			menuItems: '.post',
			menuDrop: 'ul.add'
		});
	});
	/*jQuery('.login-area').each(function(){
		new TouchNav({
			navBlock: this,
			menuItems: 'li',
			menuOpener: 'a',
			menuDrop: '.login-drop',
		});
	});*/
	// jQuery('#nav').each(function(){
	// new TouchNav({
	// navBlock: this,
	// menuItems: '.has-drop-down .has-drop-down',
	// menuOpener: '.has-drop-down-a',
	// menuDrop: '.sub-drop',
	// });
	// });
}

// add classes to support css3 selectors in old browsers
function initChildClasses() {
	jQuery('.twocolumns .col ul').children(':last-child').addClass('last-child');
}

/*
 * Mobile hover plugin
 */
; (function ($) {

	// detect device type
	var isTouchDevice = ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch,
		isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent);

	// define events
	var eventOn = 'click' || (isTouchDevice && 'touchstart') || (isWinPhoneDevice && 'MSPointerDown') || 'mouseenter',
		eventOff = (isTouchDevice && 'touchend') || (isWinPhoneDevice && 'MSPointerUp') || 'mouseleave';

	// event handlers
	var toggleOn, toggleOff, preventHandler;
	if (isTouchDevice || isWinPhoneDevice) {
		// prevent click handler
		preventHandler = function (e) {
			e.preventDefault();
		};

		// touch device handlers
		toggleOn = function (e) {
			var options = e.data, element = $(this);

			var toggleOff = function (e) {
				var target = $(e.target);
				if (!target.is(element) && !target.closest(element).length) {
					element.removeClass(options.hoverClass);
					element.off('click', preventHandler);
					if (options.onLeave) options.onLeave(element);
					$(document).off(eventOn, toggleOff);
				}
			};

			if (!element.hasClass(options.hoverClass)) {
				element.addClass(options.hoverClass);
				element.one('click', preventHandler);
				$(document).on(eventOn, toggleOff);
				if (options.onHover) options.onHover(element);
			}
		};
	} else {
		// desktop browser handlers
		toggleOn = function (e) {
			var options = e.data, element = $(this);
			element.addClass(options.hoverClass);
			$(options.context).on(eventOff, options.selector, options, toggleOff);
			if (options.onHover) options.onHover(element);
		};
		toggleOff = function (e) {
			var options = e.data, element = $(this);
			element.removeClass(options.hoverClass);
			$(options.context).off(eventOff, options.selector, toggleOff);
			if (options.onLeave) options.onLeave(element);
		};
	}

	// jQuery plugin
	$.fn.touchHover = function (opt) {
		var options = $.extend({
			context: this.context,
			selector: this.selector,
			hoverClass: 'hover'
		}, opt);

		$(this.context).on(eventOn, this.selector, options, toggleOn);
		return this;
	};
}(jQuery));

/*
 * Responsive Layout helper
 */
ResponsiveHelper = (function ($) {
	// init variables
	var handlers = [],
		prevWinWidth,
		win = $(window),
		nativeMatchMedia = false;

	// detect match media support
	if (window.matchMedia) {
		if (window.Window && window.matchMedia === Window.prototype.matchMedia) {
			nativeMatchMedia = true;
		} else if (window.matchMedia.toString().indexOf('native') > -1) {
			nativeMatchMedia = true;
		}
	}

	// prepare resize handler
	function resizeHandler() {
		var winWidth = win.width();
		if (winWidth !== prevWinWidth) {
			prevWinWidth = winWidth;

			// loop through range groups
			$.each(handlers, function (index, rangeObject) {
				// disable current active area if needed
				$.each(rangeObject.data, function (property, item) {
					if (item.currentActive && !matchRange(item.range[0], item.range[1])) {
						item.currentActive = false;
						if (typeof item.disableCallback === 'function') {
							item.disableCallback();
						}
					}
				});

				// enable areas that match current width
				$.each(rangeObject.data, function (property, item) {
					if (!item.currentActive && matchRange(item.range[0], item.range[1])) {
						// make callback
						item.currentActive = true;
						if (typeof item.enableCallback === 'function') {
							item.enableCallback();
						}
					}
				});
			});
		}
	}
	win.bind('load resize orientationchange', resizeHandler);

	// test range
	function matchRange(r1, r2) {
		var mediaQueryString = '';
		if (r1 > 0) {
			mediaQueryString += '(min-width: ' + r1 + 'px)';
		}
		if (r2 < Infinity) {
			mediaQueryString += (mediaQueryString ? ' and ' : '') + '(max-width: ' + r2 + 'px)';
		}
		return matchQuery(mediaQueryString, r1, r2);
	}

	// media query function
	function matchQuery(query, r1, r2) {
		if (window.matchMedia && nativeMatchMedia) {
			return matchMedia(query).matches;
		} else if (window.styleMedia) {
			return styleMedia.matchMedium(query);
		} else if (window.media) {
			return media.matchMedium(query);
		} else {
			return prevWinWidth >= r1 && prevWinWidth <= r2;
		}
	}

	// range parser
	function parseRange(rangeStr) {
		var rangeData = rangeStr.split('..');
		var x1 = parseInt(rangeData[0], 10) || -Infinity;
		var x2 = parseInt(rangeData[1], 10) || Infinity;
		return [x1, x2].sort(function (a, b) {
			return a - b;
		});
	}

	// export public functions
	return {
		addRange: function (ranges) {
			// parse data and add items to collection
			var result = { data: {} };
			$.each(ranges, function (property, data) {
				result.data[property] = {
					range: parseRange(property),
					enableCallback: data.on,
					disableCallback: data.off
				};
			});
			handlers.push(result);

			// call resizeHandler to recalculate all events
			prevWinWidth = null;
			resizeHandler();
		}
	};
}(jQuery));

/*
 * jQuery Carousel plugin
 */
; (function ($) {
	function ScrollGallery(options) {
		this.options = $.extend({
			mask: 'div.mask',
			slider: '>*',
			slides: '>*',
			activeClass: 'active',
			disabledClass: 'disabled',
			btnPrev: 'a.btn-prev',
			btnNext: 'a.btn-next',
			generatePagination: false,
			pagerList: '<ul>',
			pagerListItem: '<li><a href="#"></a></li>',
			pagerListItemText: 'a',
			pagerLinks: '.pagination li',
			currentNumber: 'span.current-num',
			totalNumber: 'span.total-num',
			btnPlay: '.btn-play',
			btnPause: '.btn-pause',
			btnPlayPause: '.btn-play-pause',
			galleryReadyClass: 'gallery-js-ready',
			autorotationActiveClass: 'autorotation-active',
			autorotationDisabledClass: 'autorotation-disabled',
			stretchSlideToMask: false,
			circularRotation: true,
			disableWhileAnimating: false,
			autoRotation: false,
			pauseOnHover: isTouchDevice ? false : true,
			maskAutoSize: false,
			switchTime: 4000,
			animSpeed: 600,
			event: 'click',
			swipeThreshold: 15,
			handleTouch: true,
			vertical: false,
			useTranslate3D: false,
			step: false
		}, options);
		this.init();
	}
	ScrollGallery.prototype = {
		init: function () {
			if (this.options.holder) {
				this.findElements();
				this.attachEvents();
				this.refreshPosition();
				this.refreshState(true);
				this.resumeRotation();
				this.makeCallback('onInit', this);
			}
		},
		findElements: function () {
			// define dimensions proporties
			this.fullSizeFunction = this.options.vertical ? 'outerHeight' : 'outerWidth';
			this.innerSizeFunction = this.options.vertical ? 'height' : 'width';
			this.slideSizeFunction = 'outerHeight';
			this.maskSizeProperty = 'height';
			this.animProperty = this.options.vertical ? 'marginTop' : 'marginLeft';

			// control elements
			this.gallery = $(this.options.holder).addClass(this.options.galleryReadyClass);
			this.mask = this.gallery.find(this.options.mask);
			this.slider = this.mask.find(this.options.slider);
			this.slides = this.slider.find(this.options.slides);
			this.btnPrev = this.gallery.find(this.options.btnPrev);
			this.btnNext = this.gallery.find(this.options.btnNext);
			this.currentStep = 0; this.stepsCount = 0;

			// get start index
			if (this.options.step === false) {
				var activeSlide = this.slides.filter('.' + this.options.activeClass);
				if (activeSlide.length) {
					this.currentStep = this.slides.index(activeSlide);
				}
			}

			// calculate offsets
			this.calculateOffsets();

			// create gallery pagination
			if (typeof this.options.generatePagination === 'string') {
				this.pagerLinks = $();
				this.buildPagination();
			} else {
				this.pagerLinks = this.gallery.find(this.options.pagerLinks);
				this.attachPaginationEvents();
			}

			// autorotation control buttons
			this.btnPlay = this.gallery.find(this.options.btnPlay);
			this.btnPause = this.gallery.find(this.options.btnPause);
			this.btnPlayPause = this.gallery.find(this.options.btnPlayPause);

			// misc elements
			this.curNum = this.gallery.find(this.options.currentNumber);
			this.allNum = this.gallery.find(this.options.totalNumber);
		},
		attachEvents: function () {
			// bind handlers scope
			var self = this;
			this.bindHandlers(['onWindowResize']);
			$(window).bind('load resize orientationchange', this.onWindowResize);

			// previous and next button handlers
			if (this.btnPrev.length) {
				this.prevSlideHandler = function (e) {
					e.preventDefault();
					self.prevSlide();
				};
				this.btnPrev.bind(this.options.event, this.prevSlideHandler);
			}
			if (this.btnNext.length) {
				this.nextSlideHandler = function (e) {
					e.preventDefault();
					self.nextSlide();
				};
				this.btnNext.bind(this.options.event, this.nextSlideHandler);
			}

			// pause on hover handling
			if (this.options.pauseOnHover && !isTouchDevice) {
				this.hoverHandler = function () {
					if (self.options.autoRotation) {
						self.galleryHover = true;
						self.pauseRotation();
					}
				};
				this.leaveHandler = function () {
					if (self.options.autoRotation) {
						self.galleryHover = false;
						self.resumeRotation();
					}
				};
				this.gallery.bind({ mouseenter: this.hoverHandler, mouseleave: this.leaveHandler });
			}

			// autorotation buttons handler
			if (this.btnPlay.length) {
				this.btnPlayHandler = function (e) {
					e.preventDefault();
					self.startRotation();
				};
				this.btnPlay.bind(this.options.event, this.btnPlayHandler);
			}
			if (this.btnPause.length) {
				this.btnPauseHandler = function (e) {
					e.preventDefault();
					self.stopRotation();
				};
				this.btnPause.bind(this.options.event, this.btnPauseHandler);
			}
			if (this.btnPlayPause.length) {
				this.btnPlayPauseHandler = function (e) {
					e.preventDefault();
					if (!self.gallery.hasClass(self.options.autorotationActiveClass)) {
						self.startRotation();
					} else {
						self.stopRotation();
					}
				};
				this.btnPlayPause.bind(this.options.event, this.btnPlayPauseHandler);
			}

			// enable hardware acceleration
			if (isTouchDevice && this.options.useTranslate3D) {
				this.slider.css({ '-webkit-transform': 'translate3d(0px, 0px, 0px)' });
			}

			// swipe event handling
			if (isTouchDevice && this.options.handleTouch && window.Hammer && this.mask.length) {
				this.swipeHandler = Hammer(this.mask[0], {
					dragBlockHorizontal: !this.options.vertical,
					dragBlockVertical: this.options.vertical,
					dragMinDistance: 1,
					behavior: {
						touchAction: this.options.vertical ? 'pan-x' : 'pan-y'
					}
				}).on('touch release ' + (self.options.vertical ? 'dragup dragdown' : 'dragleft dragright'), function (e) {
					switch (e.type) {
						case 'touch':
							if (self.galleryAnimating) {
								e.gesture.stopDetect();
							} else {
								self.pauseRotation();
								self.originalOffset = parseFloat(self.slider.css(self.animProperty));
							}
							break;
						case 'dragup':
						case 'dragdown':
						case 'dragleft':
						case 'dragright':
							e.gesture.preventDefault();
							var tmpOffset = self.originalOffset + e.gesture[self.options.vertical ? 'deltaY' : 'deltaX'];
							tmpOffset = Math.max(Math.min(0, tmpOffset), self.maxOffset);
							self.slider.css(self.animProperty, tmpOffset);
							break;
						case 'release':
							self.resumeRotation();
							if (Math.abs(e.gesture[self.options.vertical ? 'deltaY' : 'deltaX']) > self.options.swipeThreshold) {
								if (e.gesture.direction == 'left' || e.gesture.direction == 'up') {
									self.nextSlide();
								} else {
									self.prevSlide();
								}
							} else {
								self.switchSlide();
							}
					}
				});
			}
		},
		onWindowResize: function () {
			if (!this.galleryAnimating) {
				this.calculateOffsets();
				this.refreshPosition();
				this.buildPagination();
				this.refreshState();
				this.resizeQueue = false;
			} else {
				this.resizeQueue = true;
			}
		},
		refreshPosition: function () {
			this.currentStep = Math.min(this.currentStep, this.stepsCount - 1);
			this.tmpProps = {};
			this.tmpProps[this.animProperty] = this.getStepOffset();
			this.slider.stop().css(this.tmpProps);
		},
		calculateOffsets: function () {
			var self = this, tmpOffset, tmpStep;
			if (this.options.stretchSlideToMask) {
				var tmpObj = {};
				tmpObj[this.innerSizeFunction] = this.mask[this.innerSizeFunction]();
				this.slides.css(tmpObj);
			}

			this.maskSize = this.mask[this.innerSizeFunction]();
			this.sumSize = this.getSumSize();
			this.maxOffset = this.maskSize - this.sumSize;

			// vertical gallery with single size step custom behavior
			if (this.options.vertical && this.options.maskAutoSize) {
				this.options.step = 1;
				this.stepsCount = this.slides.length;
				this.stepOffsets = [0];
				tmpOffset = 0;
				for (var i = 0; i < this.slides.length; i++) {
					tmpOffset -= $(this.slides[i])[this.fullSizeFunction](true);
					this.stepOffsets.push(tmpOffset);
				}
				this.maxOffset = tmpOffset;
				return;
			}

			// scroll by slide size
			if (typeof this.options.step === 'number' && this.options.step > 0) {
				this.slideDimensions = [];
				this.slides.each($.proxy(function (ind, obj) {
					self.slideDimensions.push($(obj)[self.fullSizeFunction](true));
				}, this));

				// calculate steps count
				this.stepOffsets = [0];
				this.stepsCount = 1;
				tmpOffset = tmpStep = 0;
				while (tmpOffset > this.maxOffset) {
					tmpOffset -= this.getSlideSize(tmpStep, tmpStep + this.options.step);
					tmpStep += this.options.step;
					this.stepOffsets.push(Math.max(tmpOffset, this.maxOffset));
					this.stepsCount++;
				}
			}
			// scroll by mask size
			else {
				// define step size
				this.stepSize = this.maskSize;

				// calculate steps count
				this.stepsCount = 1;
				tmpOffset = 0;
				while (tmpOffset > this.maxOffset) {
					tmpOffset -= this.stepSize;
					this.stepsCount++;
				}
			}
		},
		getSumSize: function () {
			var sum = 0;
			this.slides.each($.proxy(function (ind, obj) {
				sum += $(obj)[this.fullSizeFunction](true);
			}, this));
			this.slider.css(this.innerSizeFunction, sum);
			return sum;
		},
		getStepOffset: function (step) {
			step = step || this.currentStep;
			if (typeof this.options.step === 'number') {
				return this.stepOffsets[this.currentStep];
			} else {
				return Math.min(0, Math.max(-this.currentStep * this.stepSize, this.maxOffset));
			}
		},
		getSlideSize: function (i1, i2) {
			var sum = 0;
			for (var i = i1; i < Math.min(i2, this.slideDimensions.length); i++) {
				sum += this.slideDimensions[i];
			}
			return sum;
		},
		buildPagination: function () {
			if (typeof this.options.generatePagination === 'string') {
				if (!this.pagerHolder) {
					this.pagerHolder = this.gallery.find(this.options.generatePagination);
				}
				if (this.pagerHolder.length && this.oldStepsCount != this.stepsCount) {
					this.oldStepsCount = this.stepsCount;
					this.pagerHolder.empty();
					this.pagerList = $(this.options.pagerList).appendTo(this.pagerHolder);
					for (var i = 0; i < this.stepsCount; i++) {
						$(this.options.pagerListItem).appendTo(this.pagerList).find(this.options.pagerListItemText).text(i + 1);
					}
					this.pagerLinks = this.pagerList.children();
					this.attachPaginationEvents();
				}
			}
		},
		attachPaginationEvents: function () {
			var self = this;
			this.pagerLinksHandler = function (e) {
				e.preventDefault();
				self.numSlide(self.pagerLinks.index(e.currentTarget));
			};
			this.pagerLinks.bind(this.options.event, this.pagerLinksHandler);
		},
		prevSlide: function () {
			if (!(this.options.disableWhileAnimating && this.galleryAnimating)) {
				if (this.currentStep > 0) {
					this.currentStep--;
					this.switchSlide();
				} else if (this.options.circularRotation) {
					this.currentStep = this.stepsCount - 1;
					this.switchSlide();
				}
			}
		},
		nextSlide: function (fromAutoRotation) {
			if (!(this.options.disableWhileAnimating && this.galleryAnimating)) {
				if (this.currentStep < this.stepsCount - 1) {
					this.currentStep++;
					this.switchSlide();
				} else if (this.options.circularRotation || fromAutoRotation === true) {
					this.currentStep = 0;
					this.switchSlide();
				}
			}
		},
		numSlide: function (c) {
			if (this.currentStep != c) {
				this.currentStep = c;
				this.switchSlide();
			}
		},
		switchSlide: function () {
			var self = this;
			this.galleryAnimating = true;
			this.tmpProps = {};
			this.tmpProps[this.animProperty] = this.getStepOffset();
			this.slider.stop().animate(this.tmpProps, {
				duration: this.options.animSpeed, complete: function () {
					// animation complete
					self.galleryAnimating = false;
					if (self.resizeQueue) {
						self.onWindowResize();
					}

					// onchange callback
					self.makeCallback('onChange', self);
					self.autoRotate();
				}
			});
			this.refreshState();

			// onchange callback
			this.makeCallback('onBeforeChange', this);
		},
		refreshState: function (initial) {
			if (this.options.step === 1 || this.stepsCount === this.slides.length) {
				this.slides.removeClass(this.options.activeClass).eq(this.currentStep).addClass(this.options.activeClass);
			}
			this.pagerLinks.removeClass(this.options.activeClass).eq(this.currentStep).addClass(this.options.activeClass);
			this.curNum.html(this.currentStep + 1);
			this.allNum.html(this.stepsCount);

			// initial refresh
			if (this.options.maskAutoSize && typeof this.options.step === 'number') {
				this.tmpProps = {};
				this.tmpProps[this.maskSizeProperty] = this.slides.eq(Math.min(this.currentStep, this.slides.length - 1))[this.slideSizeFunction](true);
				this.mask.stop()[initial ? 'css' : 'animate'](this.tmpProps);
			}

			// disabled state
			if (!this.options.circularRotation) {
				this.btnPrev.add(this.btnNext).removeClass(this.options.disabledClass);
				if (this.currentStep === 0) this.btnPrev.addClass(this.options.disabledClass);
				if (this.currentStep === this.stepsCount - 1) this.btnNext.addClass(this.options.disabledClass);
			}

			// add class if not enough slides
			this.gallery.toggleClass('not-enough-slides', this.sumSize <= this.maskSize);
		},
		startRotation: function () {
			this.options.autoRotation = true;
			this.galleryHover = false;
			this.autoRotationStopped = false;
			this.resumeRotation();
		},
		stopRotation: function () {
			this.galleryHover = true;
			this.autoRotationStopped = true;
			this.pauseRotation();
		},
		pauseRotation: function () {
			this.gallery.addClass(this.options.autorotationDisabledClass);
			this.gallery.removeClass(this.options.autorotationActiveClass);
			clearTimeout(this.timer);
		},
		resumeRotation: function () {
			if (!this.autoRotationStopped) {
				this.gallery.addClass(this.options.autorotationActiveClass);
				this.gallery.removeClass(this.options.autorotationDisabledClass);
				this.autoRotate();
			}
		},
		autoRotate: function () {
			var self = this;
			clearTimeout(this.timer);
			if (this.options.autoRotation && !this.galleryHover && !this.autoRotationStopped) {
				this.timer = setTimeout(function () {
					self.nextSlide(true);
				}, this.options.switchTime);
			} else {
				this.pauseRotation();
			}
		},
		bindHandlers: function (handlersList) {
			var self = this;
			$.each(handlersList, function (index, handler) {
				var origHandler = self[handler];
				self[handler] = function () {
					return origHandler.apply(self, arguments);
				};
			});
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				this.options[name].apply(this, args);
			}
		},
		destroy: function () {
			// destroy handler
			$(window).unbind('load resize orientationchange', this.onWindowResize);
			this.btnPrev.unbind(this.options.event, this.prevSlideHandler);
			this.btnNext.unbind(this.options.event, this.nextSlideHandler);
			this.pagerLinks.unbind(this.options.event, this.pagerLinksHandler);
			this.gallery.unbind({ mouseenter: this.hoverHandler, mouseleave: this.leaveHandler });

			// autorotation buttons handlers
			this.stopRotation();
			this.btnPlay.unbind(this.options.event, this.btnPlayHandler);
			this.btnPause.unbind(this.options.event, this.btnPauseHandler);
			this.btnPlayPause.unbind(this.options.event, this.btnPlayPauseHandler);

			// destroy swipe handler
			if (this.swipeHandler) {
				this.swipeHandler.dispose();
			}

			// remove inline styles, classes and pagination
			var unneededClasses = [this.options.galleryReadyClass, this.options.autorotationActiveClass, this.options.autorotationDisabledClass];
			this.gallery.removeClass(unneededClasses.join(' '));
			this.slider.add(this.slides).removeAttr('style');
			if (typeof this.options.generatePagination === 'string') {
				this.pagerHolder.empty();
			}
		}
	};

	// detect device type
	var isTouchDevice = /MSIE 10.*Touch/.test(navigator.userAgent) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;

	// jquery plugin
	$.fn.scrollGallery = function (opt) {
		return this.each(function () {
			$(this).data('ScrollGallery', new ScrollGallery($.extend(opt, { holder: this })));
		});
	};
}(jQuery));

/*
 * jQuery Dropdown plugin
 */
; (function ($) {
	function AnimDropdown(options) {
		this.options = $.extend({
			activeClass: 'drop-active',
			items: '>li',
			drop: '>ul',
			delay: 100,
			animSpeed: 300,
			effect: 'slide', // or fade
			onInit: null
		}, options);

		this.init();
	}
	AnimDropdown.prototype = {
		init: function () {

			this.findElements();
			this.attachEvents();

			this.makeCallback('onInit', this);
		},
		findElements: function () {
			var self = this;
			this.nav = $(this.options.nav);
			this.items = this.nav.find(this.options.items);
			this.delayTimer = null;

			this.items.each(function () {
				var item = $(this);
				var drop = item.find(self.options.drop);

				if (drop.length) {
					item.data('drop', drop);

					// set initial
					animation[self.options.effect].init(drop);
				}
			});
		},
		attachEvents: function () {
			var self = this;

			this.enterHandler = function () {
				var item = $(this);


				clearTimeout(self.delayTimer);
				self.hideAllDrops(item);
				self.showDrop(item);
			};
			this.leaveHandler = function () {
				clearTimeout(self.delayTimer);
				self.hideAllDrops();
			};
			this.resizeHandler = function () {
				self.hideAllDrops();
			};

			this.items.on(window.TouchNav && TouchNav.isActiveOn(this.nav.get(0)) ? 'itemhover' : 'mouseenter', this.enterHandler);
			this.items.on(window.TouchNav && TouchNav.isActiveOn(this.nav.get(0)) ? 'itemleave' : 'mouseleave', this.leaveHandler);
			jQuery(window).on('resize orientationchange', this.resizeHandler);
		},
		showDrop: function (item) {
			var self = this,
				drop = item.data('drop');

			if (drop && drop.length) {
				this.delayTimer = setTimeout(function () {
					item.addClass(self.options.activeClass);

					animation[self.options.effect].toggleState({
						state: true,
						drop: drop,
						speed: self.options.animSpeed,
					});
				}, this.options.delay);
			}
		},
		hideDrop: function (item) {
			var self = this,
				drop = item.data('drop');

			if (drop.length && item.hasClass(self.options.activeClass)) {
				animation[self.options.effect].toggleState({
					state: false,
					drop: drop,
					speed: self.options.animSpeed,
					complete: function () {
						item.removeClass(self.options.activeClass);
					}
				});
			}
		},
		hideAllDrops: function (except) {
			var self = this;
			this.delayTimer = setTimeout(function () {
				self.items.filter('.' + self.options.activeClass).not(except).each(function () {
					self.hideDrop($(this));
				});
			}, this.options.delay);
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments, 1);
				this.options[name].apply(this, args);
			}
		},
		destroy: function () {
			var self = this;

			clearTimeout(this.delayTimer);

			jQuery(window).off('resize orientationchange', this.resizeHandler);
			this.items.off(window.TouchNav && TouchNav.isActiveOn(this.nav.get(0)) ? 'itemhover' : 'mouseenter', this.enterHandler);
			this.items.off(window.TouchNav && TouchNav.isActiveOn(this.nav.get(0)) ? 'itemleave' : 'mouseleave', this.leaveHandler);

			this.items.each(function () {
				var item = $(this),
					drop = item.data('drop');

				if (drop) {
					animation[self.options.effect].destroy(drop);
				}
				item.removeClass(self.options.hoverClass + ' ' + self.options.activeClass);
				item.removeData('drop');
			});
			this.nav.removeData('AnimDropdown');
		}
	}

	var animation = {
		slide: {
			init: function (drop) {
				drop.data('dropHeight', drop.height());
				drop.css({ height: 0 }).hide();
			},
			toggleState: function (options) {
				options.drop.show().stop().animate({
					height: (options.state) ? options.drop.data('dropHeight') : 0
				}, options.speed, function () {
					if (!options.state) {
						options.drop.hide();
					}

					if (typeof options.complete === 'function') {
						options.complete();
					}
				});
			},
			destroy: function (drop) {
				drop.css({
					height: '',
					display: ''
				}).removeData('dropHeight');
			}
		},
		fade: {
			init: function (drop) {
				drop.css({ opacity: 0 }).hide();
			},
			toggleState: function (options) {
				options.drop.show().stop().animate({
					opacity: (options.state) ? 1 : 0
				}, options.speed, function () {
					if (!options.state) {
						options.drop.hide();
					}

					if (typeof options.complete === 'function') {
						options.complete();
					}
				});
			},
			destroy: function (drop) {
				drop.css({
					opasity: '',
					display: ''
				});
			}
		}
	}

	$.fn.animDropdown = function (options) {
		return this.each(function () {
			var elem = $(this);
			if (!elem.data('AnimDropdown')) {
				elem.data('AnimDropdown', new AnimDropdown($.extend(options, { nav: this })));
			}
		});
	};
}(jQuery));

/*
 * jQuery SlideShow plugin
 */
; (function ($) {
	function FadeGallery(options) {
		this.options = $.extend({
			slides: 'ul.slideset > li',
			activeClass: 'active',
			disabledClass: 'disabled',
			btnPrev: 'a.btn-prev',
			btnNext: 'a.btn-next',
			generatePagination: false,
			pagerList: '<ul>',
			pagerListItem: '<li><a href="#"></a></li>',
			pagerListItemText: 'a',
			pagerLinks: '.pagination li',
			currentNumber: 'span.current-num',
			totalNumber: 'span.total-num',
			btnPlay: '.btn-play',
			btnPause: '.btn-pause',
			btnPlayPause: '.btn-play-pause',
			galleryReadyClass: 'gallery-js-ready',
			autorotationActiveClass: 'autorotation-active',
			autorotationDisabledClass: 'autorotation-disabled',
			autorotationStopAfterClick: false,
			circularRotation: true,
			switchSimultaneously: true,
			disableWhileAnimating: false,
			disableFadeIE: false,
			autoRotation: false,
			pauseOnHover: true,
			autoHeight: false,
			useSwipe: false,
			swipeThreshold: 15,
			switchTime: 4000,
			animSpeed: 600,
			event: 'click'
		}, options);
		this.init();
	}
	FadeGallery.prototype = {
		init: function () {
			if (this.options.holder) {
				this.findElements();
				this.attachEvents();
				this.refreshState(true);
				this.autoRotate();
				this.makeCallback('onInit', this);
			}
		},
		findElements: function () {
			// control elements
			this.gallery = $(this.options.holder).addClass(this.options.galleryReadyClass);
			this.slides = this.gallery.find(this.options.slides);
			this.slidesHolder = this.slides.eq(0).parent();
			this.stepsCount = this.slides.length;
			this.btnPrev = this.gallery.find(this.options.btnPrev);
			this.btnNext = this.gallery.find(this.options.btnNext);
			this.currentIndex = 0;

			// disable fade effect in old IE
			if (this.options.disableFadeIE && !$.support.opacity) {
				this.options.animSpeed = 0;
			}

			// create gallery pagination
			if (typeof this.options.generatePagination === 'string') {
				this.pagerHolder = this.gallery.find(this.options.generatePagination).empty();
				this.pagerList = $(this.options.pagerList).appendTo(this.pagerHolder);
				for (var i = 0; i < this.stepsCount; i++) {
					$(this.options.pagerListItem).appendTo(this.pagerList).find(this.options.pagerListItemText).text(i + 1);
				}
				this.pagerLinks = this.pagerList.children();
			} else {
				this.pagerLinks = this.gallery.find(this.options.pagerLinks);
			}

			// get start index
			var activeSlide = this.slides.filter('.' + this.options.activeClass);
			if (activeSlide.length) {
				this.currentIndex = this.slides.index(activeSlide);
			}
			this.prevIndex = this.currentIndex;

			// autorotation control buttons
			this.btnPlay = this.gallery.find(this.options.btnPlay);
			this.btnPause = this.gallery.find(this.options.btnPause);
			this.btnPlayPause = this.gallery.find(this.options.btnPlayPause);

			// misc elements
			this.curNum = this.gallery.find(this.options.currentNumber);
			this.allNum = this.gallery.find(this.options.totalNumber);

			// handle flexible layout
			this.slides.css({ display: 'block', opacity: 0 }).eq(this.currentIndex).css({
				opacity: ''
			});
		},
		attachEvents: function () {
			var self = this;

			// flexible layout handler
			this.resizeHandler = function () {
				self.onWindowResize();
			};
			$(window).bind('load resize orientationchange', this.resizeHandler);

			if (this.btnPrev.length) {
				this.btnPrevHandler = function (e) {
					e.preventDefault();
					self.prevSlide();
					if (self.options.autorotationStopAfterClick) {
						self.stopRotation();
					}
				};
				this.btnPrev.bind(this.options.event, this.btnPrevHandler);
			}
			if (this.btnNext.length) {
				this.btnNextHandler = function (e) {
					e.preventDefault();
					self.nextSlide();
					if (self.options.autorotationStopAfterClick) {
						self.stopRotation();
					}
				};
				this.btnNext.bind(this.options.event, this.btnNextHandler);
			}
			if (this.pagerLinks.length) {
				this.pagerLinksHandler = function (e) {
					e.preventDefault();
					self.numSlide(self.pagerLinks.index(e.currentTarget));
					if (self.options.autorotationStopAfterClick) {
						self.stopRotation();
					}
				};
				this.pagerLinks.bind(self.options.event, this.pagerLinksHandler);
			}

			// autorotation buttons handler
			if (this.btnPlay.length) {
				this.btnPlayHandler = function (e) {
					e.preventDefault();
					self.startRotation();
				};
				this.btnPlay.bind(this.options.event, this.btnPlayHandler);
			}
			if (this.btnPause.length) {
				this.btnPauseHandler = function (e) {
					e.preventDefault();
					self.stopRotation();
				};
				this.btnPause.bind(this.options.event, this.btnPauseHandler);
			}
			if (this.btnPlayPause.length) {
				this.btnPlayPauseHandler = function (e) {
					e.preventDefault();
					if (!self.gallery.hasClass(self.options.autorotationActiveClass)) {
						self.startRotation();
					} else {
						self.stopRotation();
					}
				};
				this.btnPlayPause.bind(this.options.event, this.btnPlayPauseHandler);
			}

			// swipe gestures handler
			if (this.options.useSwipe && window.Hammer && isTouchDevice) {
				this.swipeHandler = Hammer(this.gallery[0], {
					dragBlockHorizontal: true,
					dragMinDistance: 1
				}).on('release dragleft dragright', function (e) {
					switch (e.type) {
						case 'dragleft':
						case 'dragright':
							e.gesture.preventDefault();
							break;
						case 'release':
							if (e.gesture.distance > self.options.swipeThreshold) {
								if (e.gesture.direction === 'left') {
									self.nextSlide();
								} else if (e.gesture.direction === 'right') {
									self.prevSlide();
								}
							}
					}
				});
			}

			// pause on hover handling
			if (this.options.pauseOnHover) {
				this.hoverHandler = function () {
					if (self.options.autoRotation) {
						self.galleryHover = true;
						self.pauseRotation();
					}
				};
				this.leaveHandler = function () {
					if (self.options.autoRotation) {
						self.galleryHover = false;
						self.resumeRotation();
					}
				};
				this.gallery.bind({ mouseenter: this.hoverHandler, mouseleave: this.leaveHandler });
			}
		},
		onWindowResize: function () {
			if (this.options.autoHeight) {
				this.slidesHolder.css({ height: this.slides.eq(this.currentIndex).outerHeight(true) });
			}
		},
		prevSlide: function () {
			if (!(this.options.disableWhileAnimating && this.galleryAnimating)) {
				this.prevIndex = this.currentIndex;
				if (this.currentIndex > 0) {
					this.currentIndex--;
					this.switchSlide();
				} else if (this.options.circularRotation) {
					this.currentIndex = this.stepsCount - 1;
					this.switchSlide();
				}
			}
		},
		nextSlide: function (fromAutoRotation) {
			if (!(this.options.disableWhileAnimating && this.galleryAnimating)) {
				this.prevIndex = this.currentIndex;
				if (this.currentIndex < this.stepsCount - 1) {
					this.currentIndex++;
					this.switchSlide();
				} else if (this.options.circularRotation || fromAutoRotation === true) {
					this.currentIndex = 0;
					this.switchSlide();
				}
			}
		},
		numSlide: function (c) {
			if (this.currentIndex != c) {
				this.prevIndex = this.currentIndex;
				this.currentIndex = c;
				this.switchSlide();
			}
		},
		switchSlide: function () {
			var self = this;
			if (this.slides.length > 1) {
				this.galleryAnimating = true;
				if (!this.options.animSpeed) {
					this.slides.eq(this.prevIndex).css({ opacity: 0 });
				} else {
					this.slides.eq(this.prevIndex).stop().animate({ opacity: 0 }, { duration: this.options.animSpeed });
				}

				this.switchNext = function () {
					if (!self.options.animSpeed) {
						self.slides.eq(self.currentIndex).css({ opacity: '' });
					} else {
						self.slides.eq(self.currentIndex).stop().animate({ opacity: 1 }, { duration: self.options.animSpeed });
					}
					clearTimeout(this.nextTimer);
					this.nextTimer = setTimeout(function () {
						self.slides.eq(self.currentIndex).css({ opacity: '' });
						self.galleryAnimating = false;
						self.autoRotate();

						// onchange callback
						self.makeCallback('onChange', self);
					}, self.options.animSpeed);
				};

				if (this.options.switchSimultaneously) {
					self.switchNext();
				} else {
					clearTimeout(this.switchTimer);
					this.switchTimer = setTimeout(function () {
						self.switchNext();
					}, this.options.animSpeed);
				}
				this.refreshState();

				// onchange callback
				this.makeCallback('onBeforeChange', this);
			}
		},
		refreshState: function (initial) {
			this.slides.removeClass(this.options.activeClass).eq(this.currentIndex).addClass(this.options.activeClass);
			this.pagerLinks.removeClass(this.options.activeClass).eq(this.currentIndex).addClass(this.options.activeClass);
			this.curNum.html(this.currentIndex + 1);
			this.allNum.html(this.stepsCount);

			// initial refresh
			if (this.options.autoHeight) {
				if (initial) {
					this.slidesHolder.css({ height: this.slides.eq(this.currentIndex).outerHeight(true) });
				} else {
					this.slidesHolder.stop().animate({ height: this.slides.eq(this.currentIndex).outerHeight(true) }, { duration: this.options.animSpeed });
				}
			}

			// disabled state
			if (!this.options.circularRotation) {
				this.btnPrev.add(this.btnNext).removeClass(this.options.disabledClass);
				if (this.currentIndex === 0) this.btnPrev.addClass(this.options.disabledClass);
				if (this.currentIndex === this.stepsCount - 1) this.btnNext.addClass(this.options.disabledClass);
			}

			// add class if not enough slides
			this.gallery.toggleClass('not-enough-slides', this.stepsCount === 1);
		},
		startRotation: function () {
			this.options.autoRotation = true;
			this.galleryHover = false;
			this.autoRotationStopped = false;
			this.resumeRotation();
		},
		stopRotation: function () {
			this.galleryHover = true;
			this.autoRotationStopped = true;
			this.pauseRotation();
		},
		pauseRotation: function () {
			this.gallery.addClass(this.options.autorotationDisabledClass);
			this.gallery.removeClass(this.options.autorotationActiveClass);
			clearTimeout(this.timer);
		},
		resumeRotation: function () {
			if (!this.autoRotationStopped) {
				this.gallery.addClass(this.options.autorotationActiveClass);
				this.gallery.removeClass(this.options.autorotationDisabledClass);
				this.autoRotate();
			}
		},
		autoRotate: function () {
			var self = this;
			clearTimeout(this.timer);
			if (this.options.autoRotation && !this.galleryHover && !this.autoRotationStopped) {
				this.gallery.addClass(this.options.autorotationActiveClass);
				this.timer = setTimeout(function () {
					self.nextSlide(true);
				}, this.options.switchTime);
			} else {
				this.pauseRotation();
			}
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				this.options[name].apply(this, args);
			}
		},
		destroy: function () {
			// navigation buttons handler
			this.btnPrev.unbind(this.options.event, this.btnPrevHandler);
			this.btnNext.unbind(this.options.event, this.btnNextHandler);
			this.pagerLinks.unbind(this.options.event, this.pagerLinksHandler);
			$(window).unbind('load resize orientationchange', this.resizeHandler);

			// remove autorotation handlers
			this.stopRotation();
			this.btnPlay.unbind(this.options.event, this.btnPlayHandler);
			this.btnPause.unbind(this.options.event, this.btnPauseHandler);
			this.btnPlayPause.unbind(this.options.event, this.btnPlayPauseHandler);
			this.gallery.bind({ mouseenter: this.hoverHandler, mouseleave: this.leaveHandler });

			// remove swipe handler if used
			if (this.swipeHandler) {
				this.swipeHandler.dispose();
			}
			if (typeof this.options.generatePagination === 'string') {
				this.pagerHolder.empty();
			}

			// remove unneeded classes and styles
			var unneededClasses = [this.options.galleryReadyClass, this.options.autorotationActiveClass, this.options.autorotationDisabledClass];
			this.gallery.removeClass(unneededClasses.join(' '));
			this.slidesHolder.add(this.slides).removeAttr('style');
		}
	};

	// detect device type
	var isTouchDevice = /MSIE 10.*Touch/.test(navigator.userAgent) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;

	// jquery plugin
	$.fn.fadeGallery = function (opt) {
		return this.each(function () {
			$(this).data('FadeGallery', new FadeGallery($.extend(opt, { holder: this })));
		});
	};
}(jQuery));

/*
 * jQuery Tabs plugin
 */
; (function ($) {
	$.fn.contentTabs = function (o) {
		// default options
		var options = $.extend({
			activeClass: 'active',
			addToParent: false,
			autoHeight: false,
			autoRotate: false,
			checkHash: false,
			animSpeed: 400,
			switchTime: 3000,
			effect: 'none', // "fade", "slide"
			tabLinks: 'a',
			attrib: 'href',
			event: 'click'
		}, o);

		return this.each(function () {
			var tabset = $(this), tabs = $();
			var tabLinks = tabset.find(options.tabLinks);
			var tabLinksParents = tabLinks.parent();
			var prevActiveLink = tabLinks.eq(0), currentTab, animating;
			var tabHolder;

			// handle location hash
			if (options.checkHash && tabLinks.filter('[' + options.attrib + '="' + location.hash + '"]').length) {
				(options.addToParent ? tabLinksParents : tabLinks).removeClass(options.activeClass);
				setTimeout(function () {
					window.scrollTo(0, 0);
				}, 1);
			}

			// init tabLinks
			tabLinks.each(function () {
				var link = $(this);
				var href = link.attr(options.attrib);
				var parent = link.parent();
				href = href.substr(href.lastIndexOf('#'));

				// get elements
				var tab = $(href).hide();
				tabs = tabs.add(tab);
				link.data('cparent', parent);
				link.data('ctab', tab);

				// find tab holder
				if (!tabHolder && tab.length) {
					tabHolder = tab.parent();
				}

				// show only active tab
				var classOwner = options.addToParent ? parent : link;
				if (classOwner.hasClass(options.activeClass) || (options.checkHash && location.hash === href)) {
					classOwner.addClass(options.activeClass);
					prevActiveLink = link; currentTab = tab;
					tab.removeClass(tabHiddenClass).width('');
					contentTabsEffect[options.effect].show({ tab: tab, fast: true });
				} else {
					var tabWidth = tab.width();
					if (tabWidth) {
						tab.width(tabWidth);
					}
					tab.addClass(tabHiddenClass);
				}

				// event handler
				link.bind(options.event, function (e) {
					if (link != prevActiveLink && !animating) {
						switchTab(prevActiveLink, link);
						prevActiveLink = link;
					}
				});
				if (options.attrib === 'href') {
					link.bind('click', function (e) {
						e.preventDefault();
					});
				}
			});

			// tab switch function
			function switchTab(oldLink, newLink) {
				animating = true;
				var oldTab = oldLink.data('ctab');
				var newTab = newLink.data('ctab');
				prevActiveLink = newLink;
				currentTab = newTab;

				// refresh pagination links
				(options.addToParent ? tabLinksParents : tabLinks).removeClass(options.activeClass);
				(options.addToParent ? newLink.data('cparent') : newLink).addClass(options.activeClass);

				// hide old tab
				resizeHolder(oldTab, true);
				contentTabsEffect[options.effect].hide({
					speed: options.animSpeed,
					tab: oldTab,
					complete: function () {
						// show current tab
						resizeHolder(newTab.removeClass(tabHiddenClass).width(''));
						contentTabsEffect[options.effect].show({
							speed: options.animSpeed,
							tab: newTab,
							complete: function () {
								if (!oldTab.is(newTab)) {
									oldTab.width(oldTab.width()).addClass(tabHiddenClass);
								}
								animating = false;
								resizeHolder(newTab, false);
								autoRotate();
							}
						});
					}
				});
			}

			// holder auto height
			function resizeHolder(block, state) {
				var curBlock = block && block.length ? block : currentTab;
				if (options.autoHeight && curBlock) {
					tabHolder.stop();
					if (state === false) {
						tabHolder.css({ height: '' });
					} else {
						var origStyles = curBlock.attr('style');
						curBlock.show().css({ width: curBlock.width() });
						var tabHeight = curBlock.outerHeight(true);
						if (!origStyles) curBlock.removeAttr('style'); else curBlock.attr('style', origStyles);
						if (state === true) {
							tabHolder.css({ height: tabHeight });
						} else {
							tabHolder.animate({ height: tabHeight }, { duration: options.animSpeed });
						}
					}
				}
			}
			if (options.autoHeight) {
				$(window).bind('resize orientationchange', function () {
					tabs.not(currentTab).removeClass(tabHiddenClass).show().each(function () {
						var tab = jQuery(this), tabWidth = tab.css({ width: '' }).width();
						if (tabWidth) {
							tab.width(tabWidth);
						}
					}).hide().addClass(tabHiddenClass);

					resizeHolder(currentTab, false);
				});
			}

			// autorotation handling
			var rotationTimer;
			function nextTab() {
				var activeItem = (options.addToParent ? tabLinksParents : tabLinks).filter('.' + options.activeClass);
				var activeIndex = (options.addToParent ? tabLinksParents : tabLinks).index(activeItem);
				var newLink = tabLinks.eq(activeIndex < tabLinks.length - 1 ? activeIndex + 1 : 0);
				prevActiveLink = tabLinks.eq(activeIndex);
				switchTab(prevActiveLink, newLink);
			}
			function autoRotate() {
				if (options.autoRotate && tabLinks.length > 1) {
					clearTimeout(rotationTimer);
					rotationTimer = setTimeout(function () {
						if (!animating) {
							nextTab();
						} else {
							autoRotate();
						}
					}, options.switchTime);
				}
			}
			autoRotate();
		});
	};

	// add stylesheet for tabs on DOMReady
	var tabHiddenClass = 'js-tab-hidden';
	$(function () {
		var tabStyleSheet = $('<style type="text/css">')[0];
		var tabStyleRule = '.' + tabHiddenClass;
		tabStyleRule += '{position:absolute !important;left:-9999px !important;top:-9999px !important;display:block !important}';
		if (tabStyleSheet.styleSheet) {
			tabStyleSheet.styleSheet.cssText = tabStyleRule;
		} else {
			tabStyleSheet.appendChild(document.createTextNode(tabStyleRule));
		}
		$('head').append(tabStyleSheet);
	});

	// tab switch effects
	var contentTabsEffect = {
		none: {
			show: function (o) {
				o.tab.css({ display: 'block' });
				if (o.complete) o.complete();
			},
			hide: function (o) {
				o.tab.css({ display: 'none' });
				if (o.complete) o.complete();
			}
		},
		fade: {
			show: function (o) {
				if (o.fast) o.speed = 1;
				o.tab.fadeIn(o.speed);
				if (o.complete) setTimeout(o.complete, o.speed);
			},
			hide: function (o) {
				if (o.fast) o.speed = 1;
				o.tab.fadeOut(o.speed);
				if (o.complete) setTimeout(o.complete, o.speed);
			}
		},
		slide: {
			show: function (o) {
				var tabHeight = o.tab.show().css({ width: o.tab.width() }).outerHeight(true);
				var tmpWrap = $('<div class="effect-div">').insertBefore(o.tab).append(o.tab);
				tmpWrap.css({ width: '100%', overflow: 'hidden', position: 'relative' }); o.tab.css({ marginTop: -tabHeight, display: 'block' });
				if (o.fast) o.speed = 1;
				o.tab.animate({ marginTop: 0 }, {
					duration: o.speed, complete: function () {
						o.tab.css({ marginTop: '', width: '' }).insertBefore(tmpWrap);
						tmpWrap.remove();
						if (o.complete) o.complete();
					}
				});
			},
			hide: function (o) {
				var tabHeight = o.tab.show().css({ width: o.tab.width() }).outerHeight(true);
				var tmpWrap = $('<div class="effect-div">').insertBefore(o.tab).append(o.tab);
				tmpWrap.css({ width: '100%', overflow: 'hidden', position: 'relative' });

				if (o.fast) o.speed = 1;
				o.tab.animate({ marginTop: -tabHeight }, {
					duration: o.speed, complete: function () {
						o.tab.css({ display: 'none', marginTop: '', width: '' }).insertBefore(tmpWrap);
						tmpWrap.remove();
						if (o.complete) o.complete();
					}
				});
			}
		}
	};
}(jQuery));

/*
 * jQuery Open/Close plugin
 */
; (function ($) {
	function OpenClose(options) {
		this.options = $.extend({
			addClassBeforeAnimation: true,
			hideOnClickOutside: false,
			activeClass: 'active',
			opener: '.opener',
			slider: '.slide',
			animSpeed: 400,
			effect: 'fade',
			event: 'click'
		}, options);
		this.init();
	}
	OpenClose.prototype = {
		init: function () {
			if (this.options.holder) {
				this.findElements();
				this.attachEvents();
				this.makeCallback('onInit', this);
			}
		},
		findElements: function () {
			this.holder = $(this.options.holder);
			this.opener = this.holder.find(this.options.opener);
			this.slider = this.holder.find(this.options.slider);
		},
		attachEvents: function () {
			// add handler
			var self = this;
			this.eventHandler = function (e) {
				if (self.documentMove) return;
				if (self.options.customFlag) {
					var target = jQuery(e.target);
					if (!target.closest('a').length || target.closest('.open').length) {
						// e.preventDefault();
						if (self.slider.hasClass(slideHiddenClass)) {
							self.showSlide();
						} else {
							self.hideSlide();
						}
					}
					if (target.closest('.opener-box').length) {
						e.preventDefault();
					}
				} else {
					e.preventDefault();
					if (self.slider.hasClass(slideHiddenClass)) {
						self.showSlide();
					} else {
						self.hideSlide();
					}
				}
			};
			self.opener.bind(self.options.event, this.eventHandler);

			// hover mode handler
			if (self.options.event === 'over') {
				self.opener.bind(isWinPhoneDevice ? 'MSPointerDown' : 'mouseenter ', function () {
					clearTimeout(self.timer);
					if (self.slider.hasClass(slideHiddenClass)) {
						self.showSlide();
					}
				});
				if (!isWinPhoneDevice) {
					self.holder.bind('mouseleave', function () {
						self.timer = setTimeout(function () {
							if (!self.slider.hasClass(slideHiddenClass)) {
								self.hideSlide();
							}
						}, 10);
					});
				}
			}

			// outside click handler
			self.outsideClickHandler = function (e) {
				if (self.options.hideOnClickOutside) {
					var target = $(e.target);
					if (!target.closest(self.opener).length && !target.closest('.detail-box').length && !target.closest(self.slider).length) {
						self.hideSlide();
					}
				}
			};

			// set initial styles
			if (this.holder.hasClass(this.options.activeClass)) {
				$(document).bind('click touchstart MSPointerDown', self.outsideClickHandler);
			} else {
				this.slider.addClass(slideHiddenClass);
			}
		},
		showSlide: function () {
			var self = this;
			if (self.options.addClassBeforeAnimation) {
				self.holder.addClass(self.options.activeClass);
			}
			self.slider.removeClass(slideHiddenClass);
			$(document).bind('click touchstart', self.outsideClickHandler);

			self.makeCallback('animStart', true);
			toggleEffects[self.options.effect].show({
				box: self.slider,
				speed: self.options.animSpeed,
				complete: function () {
					if (!self.options.addClassBeforeAnimation) {
						self.holder.addClass(self.options.activeClass);
					}
					self.makeCallback('animEnd', true);
				}
			});
			self.makeCallback('onBeforeShow', true);
		},
		hideSlide: function () {
			var self = this;
			if (self.options.addClassBeforeAnimation) {
				self.holder.removeClass(self.options.activeClass);
			}
			$(document).unbind('click touchstart', self.outsideClickHandler);

			self.makeCallback('animStart', false);
			toggleEffects[self.options.effect].hide({
				box: self.slider,
				speed: self.options.animSpeed,
				complete: function () {
					if (!self.options.addClassBeforeAnimation) {
						self.holder.removeClass(self.options.activeClass);
					}
					self.slider.addClass(slideHiddenClass);
					self.makeCallback('animEnd', false);
				}
			});
			self.makeCallback('onBeforeHide', true);
		},
		destroy: function () {
			this.slider.removeClass(slideHiddenClass).css({ display: '' });
			this.opener.unbind(this.options.event, this.eventHandler);
			this.holder.removeClass(this.options.activeClass).removeData('OpenClose');
			$(document).unbind('click touchstart', this.outsideClickHandler);
			this.makeCallback('onDestroy', true);
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				this.options[name].apply(this, args);
			}
		}
	};
	var isTouchDevice = ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;
	var isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent);

	// add stylesheet for slide on DOMReady
	var slideHiddenClass = 'js-slide-hidden';
	$(function () {
		var tabStyleSheet = $('<style type="text/css">')[0];
		var tabStyleRule = '.' + slideHiddenClass;
		tabStyleRule += '{position:absolute !important;left:-9999px !important;top:-9999px !important;display:block !important}';
		if (tabStyleSheet.styleSheet) {
			tabStyleSheet.styleSheet.cssText = tabStyleRule;
		} else {
			tabStyleSheet.appendChild(document.createTextNode(tabStyleRule));
		}
		$('head').append(tabStyleSheet);
	});

	// animation effects
	var toggleEffects = {
		slide: {
			show: function (o) {
				o.box.stop(true).hide().slideDown({
					duration: o.speed,
					complete: function () {
						o.complete();
					},
					step: function () {
						jQuery(window).trigger('fontresize')
					},
					// Alex: easing added
					easing: 'easeInOutCirc'
				});
			},
			hide: function (o) {
				o.box.stop(true).slideUp({
					duration: o.speed,
					complete: function () {
						o.complete();
					},
					step: function () {
						jQuery(window).trigger('fontresize')
					},
					// Alex: easing added
					easing: 'easeInOutCirc'
				});
			}
		},
		fade: {
			show: function (o) {
				o.box.stop(true).hide().fadeIn(o.speed, o.complete);
			},
			hide: function (o) {
				o.box.stop(true).fadeOut(o.speed, o.complete);
			}
		},
		none: {
			show: function (o) {
				o.box.hide().show(0, o.complete);
			},
			hide: function (o) {
				o.box.hide(0, o.complete);
			}
		}
	};

	// jQuery plugin interface
	$.fn.openClose = function (opt) {
		return this.each(function () {
			jQuery(this).data('OpenClose', new OpenClose($.extend(opt, { holder: this })));
		});
	};
}(jQuery));

/*
 * jQuery Accordion plugin
 */
; (function ($) {
	function SlideAccordion(options) {
		this.options = $.extend({
			addClassBeforeAnimation: false,
			activeClass: 'active',
			hiddenClass: 'mobile-hidden',
			opener: '.opener',
			slider: '.slide',
			animSpeed: 300,
			collapsible: true,
			event: 'click'
		}, options);

		this.init();
	}
	SlideAccordion.prototype = {
		init: function () {
			this.findElements();
			this.attachEvents();

			this.makeCallback('onInit', this);
		},
		findElements: function () {
			this.holder = $(this.options.holder);
			this.items = this.holder.children(':has(' + this.options.slider + ')').not('.' + this.options.hiddenClass);
			this.openers = this.items.find(this.options.opener);
			this.sliders = this.items.find(this.options.slider);

			// set initial styles
			this.sliders.hide();
			this.items.filter('.' + this.options.activeClass).find(this.options.slider).show();
		},
		attachEvents: function () {
			var self = this;

			this.eventHandler = function (e) {
				e.preventDefault();

				var item = $(this).closest(':has(' + self.options.slider + ')');
				if (!self.sliders.is(':animated')) {
					if (item.hasClass(self.options.activeClass)) {
						if (self.options.collapsible) {
							self.hideSlides();
						}
					} else {
						self.showSlide(item);
					}
				}
			};

			this.openers.on(this.options.event, this.eventHandler);
		},
		showSlide: function (slideHolder) {
			var slide = slideHolder.find(this.options.slider);

			this.items.removeClass(this.options.activeClass);
			this.sliders.slideUp(this.options.animSpeed);

			slideHolder.addClass(this.options.activeClass);
			slide.slideDown(this.options.animSpeed);
		},
		hideSlides: function () {
			this.items.removeClass(this.options.activeClass);
			this.sliders.slideUp(this.options.animSpeed);
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments, 1);
				this.options[name].apply(this, args);
			}
		},
		destroy: function () {
			this.items.removeClass(this.options.activeClass);
			this.openers.off(this.options.event, this.eventHandler);
			this.sliders.css({ display: '' });
			this.holder.removeData('SlideAccordion');
		}
	}

	$.fn.slideAccordion = function (options) {
		return this.each(function () {
			var elem = $(this);
			if (!elem.data('SlideAccordion')) {
				elem.data('SlideAccordion', new SlideAccordion($.extend(options, { holder: elem })));
			}
		});
	};
})(jQuery);

// autocomplete plugin
; (function ($, window) {
	// jquery plugin interface
	$.fn.autoCompleteForm = function (opt) {
		opt = $.extend({
			startCount: 1,
			dataAttr: 'q',
			ajaxAttr: 'ajax=1',
			listItems: 'li',
			listItemsFillsInput: true,
			alwaysRefresh: false,
			filterResults: true,
			highlightMatches: false,
			selectedClass: 'selected-line',
			resultsHolder: '.ajax-holder',
			inputField: 'input.text-input',
			hideDelay: 200
		}, opt);
		return this.each(function () {
			var form = $(this);
			var target = form.attr('action');
			var input = form.find(opt.inputField).attr('autocomplete', 'off');
			var ajaxHolder = form.find(opt.resultsHolder).hide();
			var acXHR, listItems, lastData, inFocus, focusTimer, visibleItems, visibleCount, currentIndex = 0;
			if (opt.filterResults) opt.alwaysRefresh = false;

			// load autocomplete data
			function loadData(callback) {
				// abort previous request if not completed
				if (acXHR && typeof acXHR.abort === 'function') {
					acXHR.abort();
				}

				// start new request
				acXHR = $.ajax({
					url: target,
					dataType: 'text',
					data: opt.ajaxAttr + '&' + opt.dataAttr + '=' + input.val(),
					success: function (msg) {
						// updating results
						updateDrop(msg);
						filterData();
						showDrop();
					},
					error: function () {
						// ajax error handling
						if (typeof opt.onerror === 'function') {
							opt.onerror.apply(this, arguments);
						}
					}
				})
			}

			// filter loaded data
			function filterData() {
				if (listItems) {
					showDrop();

					// show only items containing input text
					if (opt.filterResults) {
						listItems.show().each(function () {
							var item = $(this);
							item.html(item.data('orightml'));
							if (item.text().toLowerCase().indexOf(input.val().toLowerCase()) != -1) {
								item.show();
							}
							else {
								item.hide();
							}
						});
						if (!listItems.filter(':visible').length) {
							hideDrop();
						}
					}

					// highlight matches
					if (opt.highlightMatches) {
						listItems.children().each(function (i, obj) {
							if (input.val().length >= opt.startCount) {
								jQuery(obj).html(highlightWords(jQuery(obj).text(), input.val()));
							}
						});
					}
				}
			}

			// update dropdown content
			function updateDrop(text) {
				if (lastData != text) {
					lastData = text;
					currentIndex = -1;
					ajaxHolder.html(text);
					listItems = ajaxHolder.find(opt.listItems);
					listItems.each(function () {
						// save original html data
						var curItem = $(this);
						curItem.data('orightml', curItem.html());

						// element click behavior
						curItem.click(function () {
							return selectItem(curItem, true);
						});

						// element hover behavior
						curItem.hover(function () {
							listItems.removeClass(opt.selectedClass);
							curItem.addClass(opt.selectedClass);
							currentIndex = listItems.filter(':visible').index(curItem);
						});
					});

				}
			}

			// toggle autocomplete dropdown
			function showDrop() {
				jQuery('body').addClass('autocomplete-active');
				if (input.val().length >= opt.startCount) {
					ajaxHolder.show();
					if (!listItems.filter(':visible').length) hideDrop();
				} else {
					ajaxHolder.hide();
				}
			}
			function hideDrop() {
				jQuery('body').removeClass('autocomplete-active');
				ajaxHolder.hide();
			}
			function selectItem(obj, realEvent) {
				hideDrop();
				if (opt.listItemsFillsInput) {
					input.val(obj.text()).focus();
					return false;
				} else {
					// example redirect
					if (!realEvent) {
						window.location.href = obj.find('a:eq(0)').attr('href');
					}
				}
			}

			// event handlers
			input.keyup(function (e) {
				// skip system keys
				if (e.keyCode == 27 || e.keyCode == 13 || e.keyCode == 38 || e.keyCode == 40) return;

				// load data
				if (input.val().length < opt.startCount) hideDrop();
				if (opt.alwaysRefresh) {
					loadData();
				} else {
					if (!listItems) {
						loadData();
					}
					filterData();
				}
			}).keydown(function (e) {
				if (listItems) {
					visibleItems = listItems.filter(':visible');
					visibleCount = visibleItems.length;
					switch (e.keyCode) {
						case 13:
							selectItem(visibleItems.eq(currentIndex));
							break;
						case 27:
							hideDrop();
							break;
						case 38:
							if (currentIndex >= 0) currentIndex--;
							break;
						case 40:
							if (currentIndex < visibleCount - 1) currentIndex++;
							break;
					}

					// update classes
					listItems.removeClass(opt.selectedClass);
					if (currentIndex != -1) {
						visibleItems.eq(currentIndex).addClass(opt.selectedClass);
					}
				}
			}).focus(function () {
				clearTimeout(focusTimer);
				inFocus = true;
			}).blur(function () {
				inFocus = false;
				focusTimer = setTimeout(hideDrop, opt.hideDelay);
			});
			form.submit(function () {
				return false;
			});
		});
	}

	// regexp highlight function
	function escapeRegExp(str) {
		return str.replace(new RegExp("[.*+?|()\\[\\]{}\\\\]", "g"), "\\$&");
	}
	function highlightWords(str, word) {
		var regex = new RegExp("(" + escapeRegExp(word) + ")", "gi");
		return str.replace(regex, "<strong>$1</strong>");
	}
}(jQuery, this));

/*
 * Popups plugin
 */
; (function ($) {
	function ContentPopup(opt) {
		this.options = $.extend({
			holder: null,
			popup: '.popup',
			btnOpen: '.open',
			btnClose: '.close',
			openClass: 'popup-active',
			clickEvent: 'click',
			mode: 'click',
			hideOnClickLink: true,
			hideOnClickOutside: true,
			delay: 50
		}, opt);
		if (this.options.holder) {
			this.holder = $(this.options.holder);
			this.init();
		}
	}
	ContentPopup.prototype = {
		init: function () {
			this.findElements();
			this.attachEvents();
		},
		findElements: function () {
			this.popup = this.holder.find(this.options.popup);
			this.btnOpen = this.holder.find(this.options.btnOpen);
			this.btnClose = this.holder.find(this.options.btnClose);
			if (this.options.exceptionBlock) {
				this.exceptionBlock = jQuery(this.options.exceptionBlock);
			}
		},
		attachEvents: function () {
			// handle popup openers
			var self = this;
			this.clickMode = isTouchDevice || (self.options.mode === self.options.clickEvent);

			this.toggleHandler = function (e) {
				if (self.holder.hasClass(self.options.openClass)) {
					if (self.options.hideOnClickLink) {
						self.hidePopup();
					}
				} else {
					self.showPopup();
				}
				e.preventDefault();
			}

			if (this.clickMode) {
				// handle click mode
				this.btnOpen.bind(self.options.clickEvent, this.toggleHandler);

				// prepare outside click handler
				this.outsideClickHandler = this.bind(this.outsideClickHandler, this);
			} else {
				// handle hover mode
				var timer, delayedFunc = function (func) {
					clearTimeout(timer);
					timer = setTimeout(function () {
						func.call(self);
					}, self.options.delay);
				};
				this.btnOpen.bind('mouseover', function () {
					delayedFunc(self.showPopup);
				}).bind('mouseout', function () {
					delayedFunc(self.hidePopup);
				});
				this.popup.bind('mouseover', function () {
					delayedFunc(self.showPopup);
				}).bind('mouseout', function () {
					delayedFunc(self.hidePopup);
				});
			}

			// handle close buttons
			this.btnClose.bind(self.options.clickEvent, function (e) {
				self.hidePopup();
				e.preventDefault();
			});
		},
		outsideClickHandler: function (e) {
			// hide popup if clicked outside
			var targetNode = $((e.changedTouches ? e.changedTouches[0] : e).target);
			if (jQuery(this.options.exceptionBlock).length) {
				if (!targetNode.closest(this.popup).length && !targetNode.closest(this.btnOpen).length && !targetNode.closest(this.options.exceptionBlock).length) {
					this.hidePopup();
				}
			} else {
				if (!targetNode.closest(this.popup).length && !targetNode.closest(this.btnOpen).length) {
					this.hidePopup();
				}
			}

		},
		showPopup: function () {
			this.makeCallback('onShowPopup', this);
			// reveal popup
			this.holder.addClass(this.options.openClass);
			this.popup.css({
				position: '',
				left: '',
				top: ''
			});

			// outside click handler
			if (this.clickMode && this.options.hideOnClickOutside && !this.outsideHandlerActive) {
				this.outsideHandlerActive = true;
				$(document).bind('click touchstart', this.outsideClickHandler);
			}
		},
		hidePopup: function () {
			// hide popup
			var self = this;
			this.makeCallback('onHidePopup', this);
			this.holder.removeClass(this.options.openClass);
			if (this.options.exceptionBlock) {
				clearTimeout(this.animTimer);
				this.animTimer = setTimeout(function () {
					self.popup.css({
						position: 'absolute',
						left: -9999,
						top: -9999
					});
				}, 500);
			} else {
				this.popup.css({
					position: 'absolute',
					left: -9999,
					top: -9999
				});
			}


			// outside click handler
			if (this.clickMode && this.options.hideOnClickOutside && this.outsideHandlerActive) {
				this.outsideHandlerActive = false;
				$(document).unbind('click touchstart', this.outsideClickHandler);
			}
		},
		bind: function (f, scope, forceArgs) {
			return function () { return f.apply(scope, forceArgs ? [forceArgs] : arguments); };
		},
		destroy: function () {
			this.hidePopup();
			if (this.clickMode && this.options.hideOnClickOutside && this.outsideHandlerActive) {
				this.outsideHandlerActive = false;
				$(document).unbind('click touchstart', this.outsideClickHandler);
			}
			this.btnOpen.unbind(this.options.clickEvent, this.toggleHandler);
		},
		makeCallback: function (name) {
			if (typeof this.options[name] === 'function') {
				var args = Array.prototype.slice.call(arguments);
				args.shift();
				this.options[name].apply(this, args);
			}
		}
	};

	// detect touch devices
	var isTouchDevice = /MSIE 10.*Touch/.test(navigator.userAgent) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;

	// jQuery plugin interface
	$.fn.contentPopup = function (opt) {
		return this.each(function () {
			$(this).data('ContentPopup', new ContentPopup($.extend(opt, { holder: this })));
		});
	};
}(jQuery));

/*
 * jQuery SameHeight plugin
 */
; (function ($) {
	$.fn.sameHeight = function (opt) {
		var options = $.extend({
			skipClass: 'same-height-ignore',
			leftEdgeClass: 'same-height-left',
			rightEdgeClass: 'same-height-right',
			elements: '>*',
			flexible: false,
			multiLine: false,
			useMinHeight: false,
			biggestHeight: false
		}, opt);
		return this.each(function () {
			var holder = $(this), postResizeTimer, ignoreResize;
			var elements = holder.find(options.elements).not('.' + options.skipClass);
			if (!elements.length) return;

			// resize handler
			function doResize() {
				elements.css(options.useMinHeight && supportMinHeight ? 'minHeight' : 'height', '');
				if (options.multiLine) {
					// resize elements row by row
					resizeElementsByRows(elements, options);
				} else {
					// resize elements by holder
					resizeElements(elements, holder, options);
				}
			}
			doResize();
			holder.on('fakeResize', doResize);
			// handle flexible layout / font resize
			var delayedResizeHandler = function () {
				if (!ignoreResize) {
					ignoreResize = true;
					doResize();
					clearTimeout(postResizeTimer);
					postResizeTimer = setTimeout(function () {
						doResize();
						setTimeout(function () {
							ignoreResize = false;
						}, 10);
					}, 100);
				}
			};

			// handle flexible/responsive layout
			if (options.flexible) {
				$(window).bind('resize orientationchange fontresize', delayedResizeHandler);
			}

			// handle complete page load including images and fonts
			$(window).bind('load', delayedResizeHandler);
		});
	};

	// detect css min-height support
	var supportMinHeight = typeof document.documentElement.style.maxHeight !== 'undefined';

	// get elements by rows
	function resizeElementsByRows(boxes, options) {
		var currentRow = $(), maxHeight, maxCalcHeight = 0, firstOffset = boxes.eq(0).offset().top;
		boxes.each(function (ind) {
			var curItem = $(this);
			if (curItem.offset().top === firstOffset) {
				currentRow = currentRow.add(this);
			} else {
				maxHeight = getMaxHeight(currentRow);
				maxCalcHeight = Math.max(maxCalcHeight, resizeElements(currentRow, maxHeight, options));
				currentRow = curItem;
				firstOffset = curItem.offset().top;
			}
		});
		if (currentRow.length) {
			maxHeight = getMaxHeight(currentRow);
			maxCalcHeight = Math.max(maxCalcHeight, resizeElements(currentRow, maxHeight, options));
		}
		if (options.biggestHeight) {
			boxes.css(options.useMinHeight && supportMinHeight ? 'minHeight' : 'height', maxCalcHeight);
		}
	}

	// calculate max element height
	function getMaxHeight(boxes) {
		var maxHeight = 0;
		boxes.each(function () {
			maxHeight = Math.max(maxHeight, $(this).outerHeight());
		});
		return maxHeight;
	}

	// resize helper function
	function resizeElements(boxes, parent, options) {
		var calcHeight;
		var parentHeight = typeof parent === 'number' ? parent : parent.height();
		boxes.removeClass(options.leftEdgeClass).removeClass(options.rightEdgeClass).each(function (i) {
			var element = $(this);
			var depthDiffHeight = 0;
			var isBorderBox = element.css('boxSizing') === 'border-box' || element.css('-moz-box-sizing') === 'border-box' || '-webkit-box-sizing' === 'border-box';

			if (typeof parent !== 'number') {
				element.parents().each(function () {
					var tmpParent = $(this);
					if (parent.is(this)) {
						return false;
					} else {
						depthDiffHeight += tmpParent.outerHeight() - tmpParent.height();
					}
				});
			}
			calcHeight = parentHeight - depthDiffHeight;
			calcHeight -= isBorderBox ? 0 : element.outerHeight() - element.height();

			if (calcHeight > 0) {
				element.css(options.useMinHeight && supportMinHeight ? 'minHeight' : 'height', calcHeight);
			}
		});
		boxes.filter(':first').addClass(options.leftEdgeClass);
		boxes.filter(':last').addClass(options.rightEdgeClass);
		return calcHeight;
	}
}(jQuery));

/*
 * jQuery FontResize Event
 */
jQuery.onFontResize = (function ($) {
	$(function () {
		var randomID = 'font-resize-frame-' + Math.floor(Math.random() * 1000);
		var resizeFrame = $('<iframe>').attr('id', randomID).addClass('font-resize-helper');

		// required styles
		resizeFrame.css({
			width: '100em',
			height: '10px',
			position: 'absolute',
			borderWidth: 0,
			top: '-9999px',
			left: '-9999px'
		}).appendTo('body');

		// use native IE resize event if possible
		if (window.attachEvent && !window.addEventListener) {
			resizeFrame.bind('resize', function () {
				$.onFontResize.trigger(resizeFrame[0].offsetWidth / 100);
			});
		}
		// use script inside the iframe to detect resize for other browsers
		else {
			var doc = resizeFrame[0].contentWindow.document;
			doc.open();
			doc.write('<scri' + 'pt>window.onload = function(){var em = parent.jQuery("#' + randomID + '")[0];window.onresize = function(){if(parent.jQuery.onFontResize){parent.jQuery.onFontResize.trigger(em.offsetWidth / 100);}}};</scri' + 'pt>');
			doc.close();
		}
		jQuery.onFontResize.initialSize = resizeFrame[0].offsetWidth / 100;
	});
	return {
		// public method, so it can be called from within the iframe
		trigger: function (em) {
			$(window).trigger("fontresize", [em]);
		}
	};
}(jQuery));

/*! http://mths.be/placeholder v2.0.7 by @mathias */
; (function (window, document, $) {

	// Opera Mini v7 doesnâ€™t support placeholder although its DOM seems to indicate so
	var isOperaMini = Object.prototype.toString.call(window.operamini) == '[object OperaMini]';
	var isInputSupported = 'placeholder' in document.createElement('input') && !isOperaMini;
	var isTextareaSupported = 'placeholder' in document.createElement('textarea') && !isOperaMini;
	var prototype = $.fn;
	var valHooks = $.valHooks;
	var propHooks = $.propHooks;
	var hooks;
	var placeholder;

	if (isInputSupported && isTextareaSupported) {

		placeholder = prototype.placeholder = function () {
			return this;
		};

		placeholder.input = placeholder.textarea = true;

	} else {

		placeholder = prototype.placeholder = function () {
			var $this = this;
			$this
				.filter((isInputSupported ? 'textarea' : ':input') + '[placeholder]')
				.not('.placeholder')
				.bind({
					'focus.placeholder': clearPlaceholder,
					'blur.placeholder': setPlaceholder
				})
				.data('placeholder-enabled', true)
				.trigger('blur.placeholder');
			return $this;
		};

		placeholder.input = isInputSupported;
		placeholder.textarea = isTextareaSupported;

		hooks = {
			'get': function (element) {
				var $element = $(element);

				var $passwordInput = $element.data('placeholder-password');
				if ($passwordInput) {
					return $passwordInput[0].value;
				}

				return $element.data('placeholder-enabled') && $element.hasClass('placeholder') ? '' : element.value;
			},
			'set': function (element, value) {
				var $element = $(element);

				var $passwordInput = $element.data('placeholder-password');
				if ($passwordInput) {
					return $passwordInput[0].value = value;
				}

				if (!$element.data('placeholder-enabled')) {
					return element.value = value;
				}
				if (value == '') {
					element.value = value;
					// Issue #56: Setting the placeholder causes problems if the element continues to have focus.
					if (element != safeActiveElement()) {
						// We can't use `triggerHandler` here because of dummy text/password inputs :(
						setPlaceholder.call(element);
					}
				} else if ($element.hasClass('placeholder')) {
					clearPlaceholder.call(element, true, value) || (element.value = value);
				} else {
					element.value = value;
				}
				// `set` can not return `undefined`; see http://jsapi.info/jquery/1.7.1/val#L2363
				return $element;
			}
		};

		if (!isInputSupported) {
			valHooks.input = hooks;
			propHooks.value = hooks;
		}
		if (!isTextareaSupported) {
			valHooks.textarea = hooks;
			propHooks.value = hooks;
		}

		$(function () {
			// Look for forms
			$(document).delegate('form', 'submit.placeholder', function () {
				// Clear the placeholder values so they don't get submitted
				var $inputs = $('.placeholder', this).each(clearPlaceholder);
				setTimeout(function () {
					$inputs.each(setPlaceholder);
				}, 10);
			});
		});

		// Clear placeholder values upon page reload
		$(window).bind('beforeunload.placeholder', function () {
			$('.placeholder').each(function () {
				this.value = '';
			});
		});

	}

	function args(elem) {
		// Return an object of element attributes
		var newAttrs = {};
		var rinlinejQuery = /^jQuery\d+$/;
		$.each(elem.attributes, function (i, attr) {
			if (attr.specified && !rinlinejQuery.test(attr.name)) {
				newAttrs[attr.name] = attr.value;
			}
		});
		return newAttrs;
	}

	function clearPlaceholder(event, value) {
		var input = this;
		var $input = $(input);
		if (input.value == $input.attr('placeholder') && $input.hasClass('placeholder')) {
			if ($input.data('placeholder-password')) {
				$input = $input.hide().next().show().attr('id', $input.removeAttr('id').data('placeholder-id'));
				// If `clearPlaceholder` was called from `$.valHooks.input.set`
				if (event === true) {
					return $input[0].value = value;
				}
				$input.focus();
			} else {
				input.value = '';
				$input.removeClass('placeholder');
				input == safeActiveElement() && input.select();
			}
		}
	}

	function setPlaceholder() {
		var $replacement;
		var input = this;
		var $input = $(input);
		var id = this.id;
		if (input.value == '') {
			if (input.type == 'password') {
				if (!$input.data('placeholder-textinput')) {
					try {
						$replacement = $input.clone().attr({ 'type': 'text' });
					} catch (e) {
						$replacement = $('<input>').attr($.extend(args(this), { 'type': 'text' }));
					}
					$replacement
						.removeAttr('name')
						.data({
							'placeholder-password': $input,
							'placeholder-id': id
						})
						.bind('focus.placeholder', clearPlaceholder);
					$input
						.data({
							'placeholder-textinput': $replacement,
							'placeholder-id': id
						})
						.before($replacement);
				}
				$input = $input.removeAttr('id').hide().prev().attr('id', id).show();
				// Note: `$input[0] != input` now!
			}
			$input.addClass('placeholder');
			$input[0].value = $input.attr('placeholder');
		} else {
			$input.removeClass('placeholder');
		}
	}

	function safeActiveElement() {
		// Avoid IE9 `document.activeElement` of death
		// https://github.com/mathiasbynens/jquery-placeholder/pull/99
		try {
			return document.activeElement;
		} catch (err) { }
	}

}(this, document, jQuery));

/*
 * JavaScript Custom Forms Module
 */
jcf = {
	// global options
	modules: {},
	plugins: {},
	baseOptions: {
		unselectableClass: 'jcf-unselectable',
		labelActiveClass: 'jcf-label-active',
		labelDisabledClass: 'jcf-label-disabled',
		classPrefix: 'jcf-class-',
		hiddenClass: 'jcf-hidden',
		focusClass: 'jcf-focus',
		wrapperTag: 'div'
	},
	// replacer function
	customForms: {
		setOptions: function (obj) {
			for (var p in obj) {
				if (obj.hasOwnProperty(p) && typeof obj[p] === 'object') {
					jcf.lib.extend(jcf.modules[p].prototype.defaultOptions, obj[p]);
				}
			}
		},
		replaceAll: function (context) {
			for (var k in jcf.modules) {
				var els = jcf.lib.queryBySelector(jcf.modules[k].prototype.selector, context);
				for (var i = 0; i < els.length; i++) {
					if (els[i].jcf) {
						// refresh form element state
						els[i].jcf.refreshState();
					} else {
						// replace form element
						if (!jcf.lib.hasClass(els[i], 'default') && jcf.modules[k].prototype.checkElement(els[i])) {
							new jcf.modules[k]({
								replaces: els[i]
							});
						}
					}
				}
			}
		},
		refreshAll: function (context) {
			for (var k in jcf.modules) {
				var els = jcf.lib.queryBySelector(jcf.modules[k].prototype.selector, context);
				for (var i = 0; i < els.length; i++) {
					if (els[i].jcf) {
						// refresh form element state
						els[i].jcf.refreshState();
					}
				}
			}
		},
		refreshElement: function (obj) {
			if (obj && obj.jcf) {
				obj.jcf.refreshState();
			}
		},
		destroyAll: function () {
			for (var k in jcf.modules) {
				var els = jcf.lib.queryBySelector(jcf.modules[k].prototype.selector);
				for (var i = 0; i < els.length; i++) {
					if (els[i].jcf) {
						els[i].jcf.destroy();
					}
				}
			}
		},
		destroy: function (obj) { //destroy styling for element
			obj.jcf.destroy();
		}
	},
	// detect device type
	isTouchDevice: ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch,
	isWinPhoneDevice: navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent),
	// define base module
	setBaseModule: function (obj) {
		jcf.customControl = function (opt) {
			this.options = jcf.lib.extend({}, jcf.baseOptions, this.defaultOptions, opt);
			this.init();
		};
		for (var p in obj) {
			jcf.customControl.prototype[p] = obj[p];
		}
	},
	// add module to jcf.modules
	addModule: function (obj) {
		if (obj.name) {
			// create new module proto class
			jcf.modules[obj.name] = function () {
				jcf.modules[obj.name].superclass.constructor.apply(this, arguments);
			}
			jcf.lib.inherit(jcf.modules[obj.name], jcf.customControl);
			for (var p in obj) {
				jcf.modules[obj.name].prototype[p] = obj[p]
			}
			// on create module
			jcf.modules[obj.name].prototype.onCreateModule();
			// make callback for exciting modules
			for (var mod in jcf.modules) {
				if (jcf.modules[mod] != jcf.modules[obj.name]) {
					jcf.modules[mod].prototype.onModuleAdded(jcf.modules[obj.name]);
				}
			}
		}
	},
	// add plugin to jcf.plugins
	addPlugin: function (obj) {
		if (obj && obj.name) {
			jcf.plugins[obj.name] = function () {
				this.init.apply(this, arguments);
			}
			for (var p in obj) {
				jcf.plugins[obj.name].prototype[p] = obj[p];
			}
		}
	},
	// miscellaneous init
	init: function () {
		if (navigator.pointerEnabled || navigator.msPointerEnabled) {
			// use pointer events instead of mouse events
			this.eventPress = navigator.pointerEnabled ? 'pointerdown' : 'MSPointerDown';
			this.eventMove = navigator.pointerEnabled ? 'pointermove' : 'MSPointerMove';
			this.eventRelease = navigator.pointerEnabled ? 'pointerup' : 'MSPointerUp';
		} else {
			// handle default desktop mouse events
			this.eventPress = 'mousedown';
			this.eventMove = 'mousemove';
			this.eventRelease = 'mouseup';
		}
		if (this.isTouchDevice) {
			// handle touch events also
			this.eventPress += ' touchstart';
			this.eventMove += ' touchmove';
			this.eventRelease += ' touchend';
		}

		setTimeout(function () {
			jcf.lib.domReady(function () {
				jcf.initStyles();
			});
		}, 1);
		return this;
	},
	initStyles: function () {
		// create <style> element and rules
		var head = document.getElementsByTagName('head')[0],
			style = document.createElement('style'),
			rules = document.createTextNode('.' + jcf.baseOptions.unselectableClass + '{' +
				'-moz-user-select:none;' +
				'-webkit-tap-highlight-color:rgba(255,255,255,0);' +
				'-webkit-user-select:none;' +
				'user-select:none;' +
				'}');

		// append style element
		style.type = 'text/css';
		if (style.styleSheet) {
			style.styleSheet.cssText = rules.nodeValue;
		} else {
			style.appendChild(rules);
		}
		head.appendChild(style);
	}
}.init();

/*
 * Custom Form Control prototype
 */
jcf.setBaseModule({
	init: function () {
		if (this.options.replaces) {
			this.realElement = this.options.replaces;
			this.realElement.jcf = this;
			this.replaceObject();
		}
	},
	defaultOptions: {
		// default module options (will be merged with base options)
	},
	checkElement: function (el) {
		return true; // additional check for correct form element
	},
	replaceObject: function () {
		this.createWrapper();
		this.attachEvents();
		this.fixStyles();
		this.setupWrapper();
	},
	createWrapper: function () {
		this.fakeElement = jcf.lib.createElement(this.options.wrapperTag);
		this.labelFor = jcf.lib.getLabelFor(this.realElement);
		jcf.lib.disableTextSelection(this.fakeElement);
		jcf.lib.addClass(this.fakeElement, jcf.lib.getAllClasses(this.realElement.className, this.options.classPrefix));
		jcf.lib.addClass(this.realElement, jcf.baseOptions.hiddenClass);
	},
	attachEvents: function () {
		jcf.lib.event.add(this.realElement, 'focus', this.onFocusHandler, this);
		jcf.lib.event.add(this.realElement, 'blur', this.onBlurHandler, this);
		jcf.lib.event.add(this.fakeElement, 'click', this.onFakeClick, this);
		jcf.lib.event.add(this.fakeElement, jcf.eventPress, this.onFakePressed, this);
		jcf.lib.event.add(this.fakeElement, jcf.eventRelease, this.onFakeReleased, this);

		if (this.labelFor) {
			this.labelFor.jcf = this;
			jcf.lib.event.add(this.labelFor, 'click', this.onFakeClick, this);
			jcf.lib.event.add(this.labelFor, jcf.eventPress, this.onFakePressed, this);
			jcf.lib.event.add(this.labelFor, jcf.eventRelease, this.onFakeReleased, this);
		}
	},
	fixStyles: function () {
		// hide mobile webkit tap effect
		if (jcf.isTouchDevice) {
			var tapStyle = 'rgba(255,255,255,0)';
			this.realElement.style.webkitTapHighlightColor = tapStyle;
			this.fakeElement.style.webkitTapHighlightColor = tapStyle;
			if (this.labelFor) {
				this.labelFor.style.webkitTapHighlightColor = tapStyle;
			}
		}
	},
	setupWrapper: function () {
		// implement in subclass
	},
	refreshState: function () {
		// implement in subclass
	},
	destroy: function () {
		if (this.fakeElement && this.fakeElement.parentNode) {
			this.fakeElement.parentNode.insertBefore(this.realElement, this.fakeElement);
			this.fakeElement.parentNode.removeChild(this.fakeElement);
		}
		jcf.lib.removeClass(this.realElement, jcf.baseOptions.hiddenClass);
		this.realElement.jcf = null;
	},
	onFocus: function () {
		// emulated focus event
		jcf.lib.addClass(this.fakeElement, this.options.focusClass);
	},
	onBlur: function (cb) {
		// emulated blur event
		jcf.lib.removeClass(this.fakeElement, this.options.focusClass);
	},
	onFocusHandler: function () {
		// handle focus loses
		if (this.focused) return;
		this.focused = true;

		// handle touch devices also
		if (jcf.isTouchDevice) {
			if (jcf.focusedInstance && jcf.focusedInstance.realElement != this.realElement) {
				jcf.focusedInstance.onBlur();
				jcf.focusedInstance.realElement.blur();
			}
			jcf.focusedInstance = this;
		}
		this.onFocus.apply(this, arguments);
	},
	onBlurHandler: function () {
		// handle focus loses
		if (!this.pressedFlag) {
			this.focused = false;
			this.onBlur.apply(this, arguments);
		}
	},
	onFakeClick: function () {
		if (jcf.isTouchDevice) {
			this.onFocus();
		} else if (!this.realElement.disabled) {
			this.realElement.focus();
		}
	},
	onFakePressed: function (e) {
		this.pressedFlag = true;
	},
	onFakeReleased: function () {
		this.pressedFlag = false;
	},
	onCreateModule: function () {
		// implement in subclass
	},
	onModuleAdded: function (module) {
		// implement in subclass
	},
	onControlReady: function () {
		// implement in subclass
	}
});

/*
 * JCF Utility Library
 */
jcf.lib = {
	bind: function (func, scope) {
		return function () {
			return func.apply(scope, arguments);
		};
	},
	browser: (function () {
		var ua = navigator.userAgent.toLowerCase(), res = {},
			match = /(webkit)[ \/]([\w.]+)/.exec(ua) || /(opera)(?:.*version)?[ \/]([\w.]+)/.exec(ua) ||
				/(msie) ([\w.]+)/.exec(ua) || ua.indexOf("compatible") < 0 && /(mozilla)(?:.*? rv:([\w.]+))?/.exec(ua) || [];
		res[match[1]] = true;
		res.version = match[2] || "0";
		res.safariMac = ua.indexOf('mac') != -1 && ua.indexOf('safari') != -1;
		return res;
	})(),
	getOffset: function (obj) {
		if (obj.getBoundingClientRect && !jcf.isWinPhoneDevice) {
			var scrollLeft = window.pageXOffset || document.documentElement.scrollLeft || document.body.scrollLeft;
			var scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop;
			var clientLeft = document.documentElement.clientLeft || document.body.clientLeft || 0;
			var clientTop = document.documentElement.clientTop || document.body.clientTop || 0;
			return {
				top: Math.round(obj.getBoundingClientRect().top + scrollTop - clientTop),
				left: Math.round(obj.getBoundingClientRect().left + scrollLeft - clientLeft)
			};
		} else {
			var posLeft = 0, posTop = 0;
			while (obj.offsetParent) { posLeft += obj.offsetLeft; posTop += obj.offsetTop; obj = obj.offsetParent; }
			return { top: posTop, left: posLeft };
		}
	},
	getScrollTop: function () {
		return window.pageYOffset || document.documentElement.scrollTop;
	},
	getScrollLeft: function () {
		return window.pageXOffset || document.documentElement.scrollLeft;
	},
	getWindowWidth: function () {
		return document.compatMode == 'CSS1Compat' ? document.documentElement.clientWidth : document.body.clientWidth;
	},
	getWindowHeight: function () {
		return document.compatMode == 'CSS1Compat' ? document.documentElement.clientHeight : document.body.clientHeight;
	},
	getStyle: function (el, prop) {
		if (document.defaultView && document.defaultView.getComputedStyle) {
			return document.defaultView.getComputedStyle(el, null)[prop];
		} else if (el.currentStyle) {
			return el.currentStyle[prop];
		} else {
			return el.style[prop];
		}
	},
	getParent: function (obj, selector) {
		while (obj.parentNode && obj.parentNode != document.body) {
			if (obj.parentNode.tagName.toLowerCase() == selector.toLowerCase()) {
				return obj.parentNode;
			}
			obj = obj.parentNode;
		}
		return false;
	},
	isParent: function (parent, child) {
		while (child.parentNode) {
			if (child.parentNode === parent) {
				return true;
			}
			child = child.parentNode;
		}
		return false;
	},
	getLabelFor: function (object) {
		var parentLabel = jcf.lib.getParent(object, 'label');
		if (parentLabel) {
			return parentLabel;
		} else if (object.id) {
			return jcf.lib.queryBySelector('label[for="' + object.id + '"]')[0];
		}
	},
	disableTextSelection: function (el) {
		if (typeof el.onselectstart !== 'undefined') {
			el.onselectstart = function () { return false; };
		} else if (window.opera) {
			el.setAttribute('unselectable', 'on');
		} else {
			jcf.lib.addClass(el, jcf.baseOptions.unselectableClass);
		}
	},
	enableTextSelection: function (el) {
		if (typeof el.onselectstart !== 'undefined') {
			el.onselectstart = null;
		} else if (window.opera) {
			el.removeAttribute('unselectable');
		} else {
			jcf.lib.removeClass(el, jcf.baseOptions.unselectableClass);
		}
	},
	queryBySelector: function (selector, scope) {
		if (typeof scope === 'string') {
			var result = [];
			var holders = this.getElementsBySelector(scope);
			for (var i = 0, contextNodes; i < holders.length; i++) {
				contextNodes = Array.prototype.slice.call(this.getElementsBySelector(selector, holders[i]));
				result = result.concat(contextNodes);
			}
			return result;
		} else {
			return this.getElementsBySelector(selector, scope);
		}
	},
	prevSibling: function (node) {
		while (node = node.previousSibling) if (node.nodeType == 1) break;
		return node;
	},
	nextSibling: function (node) {
		while (node = node.nextSibling) if (node.nodeType == 1) break;
		return node;
	},
	fireEvent: function (element, event) {
		if (element.dispatchEvent) {
			var evt = document.createEvent('HTMLEvents');
			evt.initEvent(event, true, true);
			return !element.dispatchEvent(evt);
		} else if (document.createEventObject) {
			var evt = document.createEventObject();
			return element.fireEvent('on' + event, evt);
		}
	},
	inherit: function (Child, Parent) {
		var F = function () { }
		F.prototype = Parent.prototype
		Child.prototype = new F()
		Child.prototype.constructor = Child
		Child.superclass = Parent.prototype
	},
	extend: function (obj) {
		for (var i = 1; i < arguments.length; i++) {
			for (var p in arguments[i]) {
				if (arguments[i].hasOwnProperty(p)) {
					obj[p] = arguments[i][p];
				}
			}
		}
		return obj;
	},
	hasClass: function (obj, cname) {
		return (obj.className ? obj.className.match(new RegExp('(\\s|^)' + cname + '(\\s|$)')) : false);
	},
	addClass: function (obj, cname) {
		if (!this.hasClass(obj, cname)) obj.className += (!obj.className.length || obj.className.charAt(obj.className.length - 1) === ' ' ? '' : ' ') + cname;
	},
	removeClass: function (obj, cname) {
		if (this.hasClass(obj, cname)) obj.className = obj.className.replace(new RegExp('(\\s|^)' + cname + '(\\s|$)'), ' ').replace(/\s+$/, '');
	},
	toggleClass: function (obj, cname, condition) {
		if (condition) this.addClass(obj, cname); else this.removeClass(obj, cname);
	},
	createElement: function (tagName, options) {
		var el = document.createElement(tagName);
		for (var p in options) {
			if (options.hasOwnProperty(p)) {
				switch (p) {
					case 'class': el.className = options[p]; break;
					case 'html': el.innerHTML = options[p]; break;
					case 'style': this.setStyles(el, options[p]); break;
					default: el.setAttribute(p, options[p]);
				}
			}
		}
		return el;
	},
	setStyles: function (el, styles) {
		for (var p in styles) {
			if (styles.hasOwnProperty(p)) {
				switch (p) {
					case 'float': el.style.cssFloat = styles[p]; break;
					case 'opacity': el.style.filter = 'progid:DXImageTransform.Microsoft.Alpha(opacity=' + styles[p] * 100 + ')'; el.style.opacity = styles[p]; break;
					default: el.style[p] = (typeof styles[p] === 'undefined' ? 0 : styles[p]) + (typeof styles[p] === 'number' ? 'px' : '');
				}
			}
		}
		return el;
	},
	getInnerWidth: function (el) {
		return el.offsetWidth - (parseInt(this.getStyle(el, 'paddingLeft')) || 0) - (parseInt(this.getStyle(el, 'paddingRight')) || 0);
	},
	getInnerHeight: function (el) {
		return el.offsetHeight - (parseInt(this.getStyle(el, 'paddingTop')) || 0) - (parseInt(this.getStyle(el, 'paddingBottom')) || 0);
	},
	getAllClasses: function (cname, prefix, skip) {
		if (!skip) skip = '';
		if (!prefix) prefix = '';
		return cname ? cname.replace(new RegExp('(\\s|^)' + skip + '(\\s|$)'), ' ').replace(/[\s]*([\S]+)+[\s]*/gi, prefix + "$1 ") : '';
	},
	getElementsBySelector: function (selector, scope) {
		if (typeof document.querySelectorAll === 'function') {
			return (scope || document).querySelectorAll(selector);
		}
		var selectors = selector.split(',');
		var resultList = [];
		for (var s = 0; s < selectors.length; s++) {
			var currentContext = [scope || document];
			var tokens = selectors[s].replace(/^\s+/, '').replace(/\s+$/, '').split(' ');
			for (var i = 0; i < tokens.length; i++) {
				token = tokens[i].replace(/^\s+/, '').replace(/\s+$/, '');
				if (token.indexOf('#') > -1) {
					var bits = token.split('#'), tagName = bits[0], id = bits[1];
					var element = document.getElementById(id);
					if (tagName && element.nodeName.toLowerCase() != tagName) {
						return [];
					}
					currentContext = [element];
					continue;
				}
				if (token.indexOf('.') > -1) {
					var bits = token.split('.'), tagName = bits[0] || '*', className = bits[1], found = [], foundCount = 0;
					for (var h = 0; h < currentContext.length; h++) {
						var elements;
						if (tagName == '*') {
							elements = currentContext[h].getElementsByTagName('*');
						} else {
							elements = currentContext[h].getElementsByTagName(tagName);
						}
						for (var j = 0; j < elements.length; j++) {
							found[foundCount++] = elements[j];
						}
					}
					currentContext = [];
					var currentContextIndex = 0;
					for (var k = 0; k < found.length; k++) {
						if (found[k].className && found[k].className.match(new RegExp('(\\s|^)' + className + '(\\s|$)'))) {
							currentContext[currentContextIndex++] = found[k];
						}
					}
					continue;
				}
				if (token.match(/^(\w*)\[(\w+)([=~\|\^\$\*]?)=?"?([^"]*)"?\]$/)) {
					var tagName = RegExp.$1 || '*', attrName = RegExp.$2, attrOperator = RegExp.$3, attrValue = RegExp.$4;
					if (attrName.toLowerCase() == 'for' && this.browser.msie && this.browser.version < 8) {
						attrName = 'htmlFor';
					}
					var found = [], foundCount = 0;
					for (var h = 0; h < currentContext.length; h++) {
						var elements;
						if (tagName == '*') {
							elements = currentContext[h].getElementsByTagName('*');
						} else {
							elements = currentContext[h].getElementsByTagName(tagName);
						}
						for (var j = 0; elements[j]; j++) {
							found[foundCount++] = elements[j];
						}
					}
					currentContext = [];
					var currentContextIndex = 0, checkFunction;
					switch (attrOperator) {
						case '=': checkFunction = function (e) { return (e.getAttribute(attrName) == attrValue) }; break;
						case '~': checkFunction = function (e) { return (e.getAttribute(attrName).match(new RegExp('(\\s|^)' + attrValue + '(\\s|$)'))) }; break;
						case '|': checkFunction = function (e) { return (e.getAttribute(attrName).match(new RegExp('^' + attrValue + '-?'))) }; break;
						case '^': checkFunction = function (e) { return (e.getAttribute(attrName).indexOf(attrValue) == 0) }; break;
						case '$': checkFunction = function (e) { return (e.getAttribute(attrName).lastIndexOf(attrValue) == e.getAttribute(attrName).length - attrValue.length) }; break;
						case '*': checkFunction = function (e) { return (e.getAttribute(attrName).indexOf(attrValue) > -1) }; break;
						default: checkFunction = function (e) { return e.getAttribute(attrName) };
					}
					currentContext = [];
					var currentContextIndex = 0;
					for (var k = 0; k < found.length; k++) {
						if (checkFunction(found[k])) {
							currentContext[currentContextIndex++] = found[k];
						}
					}
					continue;
				}
				tagName = token;
				var found = [], foundCount = 0;
				for (var h = 0; h < currentContext.length; h++) {
					var elements = currentContext[h].getElementsByTagName(tagName);
					for (var j = 0; j < elements.length; j++) {
						found[foundCount++] = elements[j];
					}
				}
				currentContext = found;
			}
			resultList = [].concat(resultList, currentContext);
		}
		return resultList;
	},
	scrollSize: (function () {
		var content, hold, sizeBefore, sizeAfter;
		function buildSizer() {
			if (hold) removeSizer();
			content = document.createElement('div');
			hold = document.createElement('div');
			hold.style.cssText = 'position:absolute;overflow:hidden;width:100px;height:100px';
			hold.appendChild(content);
			document.body.appendChild(hold);
		}
		function removeSizer() {
			document.body.removeChild(hold);
			hold = null;
		}
		function calcSize(vertical) {
			buildSizer();
			content.style.cssText = 'height:' + (vertical ? '100%' : '200px');
			sizeBefore = (vertical ? content.offsetHeight : content.offsetWidth);
			hold.style.overflow = 'scroll'; content.innerHTML = 1;
			sizeAfter = (vertical ? content.offsetHeight : content.offsetWidth);
			if (vertical && hold.clientHeight) sizeAfter = hold.clientHeight;
			removeSizer();
			return sizeBefore - sizeAfter;
		}
		return {
			getWidth: function () {
				return calcSize(false);
			},
			getHeight: function () {
				return calcSize(true)
			}
		}
	}()),
	domReady: function (handler) {
		var called = false
		function ready() {
			if (called) return;
			called = true;
			handler();
		}
		if (document.addEventListener) {
			document.addEventListener("DOMContentLoaded", ready, false);
		} else if (document.attachEvent) {
			if (document.documentElement.doScroll && window == window.top) {
				function tryScroll() {
					if (called) return
					if (!document.body) return
					try {
						document.documentElement.doScroll("left")
						ready()
					} catch (e) {
						setTimeout(tryScroll, 0)
					}
				}
				tryScroll()
			}
			document.attachEvent("onreadystatechange", function () {
				if (document.readyState === "complete") {
					ready()
				}
			})
		}
		if (window.addEventListener) window.addEventListener('load', ready, false)
		else if (window.attachEvent) window.attachEvent('onload', ready)
	},
	event: (function () {
		var guid = 0;
		function fixEvent(e) {
			e = e || window.event;
			if (e.isFixed) {
				return e;
			}
			e.isFixed = true;
			e.preventDefault = e.preventDefault || function () { this.returnValue = false }
			e.stopPropagation = e.stopPropagation || function () { this.cancelBubble = true }
			if (!e.target) {
				e.target = e.srcElement
			}
			if (!e.relatedTarget && e.fromElement) {
				e.relatedTarget = e.fromElement == e.target ? e.toElement : e.fromElement;
			}
			if (e.pageX == null && e.clientX != null) {
				var html = document.documentElement, body = document.body;
				e.pageX = e.clientX + (html && html.scrollLeft || body && body.scrollLeft || 0) - (html.clientLeft || 0);
				e.pageY = e.clientY + (html && html.scrollTop || body && body.scrollTop || 0) - (html.clientTop || 0);
			}
			if (!e.which && e.button) {
				e.which = e.button & 1 ? 1 : (e.button & 2 ? 3 : (e.button & 4 ? 2 : 0));
			}
			if (e.type === "DOMMouseScroll" || e.type === 'mousewheel') {
				e.mWheelDelta = 0;
				if (e.wheelDelta) {
					e.mWheelDelta = e.wheelDelta / 120;
				} else if (e.detail) {
					e.mWheelDelta = -e.detail / 3;
				}
			}
			return e;
		}
		function commonHandle(event, customScope) {
			event = fixEvent(event);
			var handlers = this.events[event.type];
			for (var g in handlers) {
				var handler = handlers[g];
				var ret = handler.call(customScope || this, event);
				if (ret === false) {
					event.preventDefault()
					event.stopPropagation()
				}
			}
		}
		var publicAPI = {
			add: function (elem, type, handler, forcedScope) {
				// handle multiple events
				if (type.indexOf(' ') > -1) {
					var eventList = type.split(' ');
					for (var i = 0; i < eventList.length; i++) {
						publicAPI.add(elem, eventList[i], handler, forcedScope);
					}
					return;
				}

				if (elem.setInterval && (elem != window && !elem.frameElement)) {
					elem = window;
				}
				if (!handler.guid) {
					handler.guid = ++guid;
				}
				if (!elem.events) {
					elem.events = {};
					elem.handle = function (event) {
						return commonHandle.call(elem, event);
					}
				}
				if (!elem.events[type]) {
					elem.events[type] = {};
					if (elem.addEventListener) elem.addEventListener(type, elem.handle, false);
					else if (elem.attachEvent) elem.attachEvent("on" + type, elem.handle);
					if (type === 'mousewheel') {
						publicAPI.add(elem, 'DOMMouseScroll', handler, forcedScope);
					}
				}
				var fakeHandler = jcf.lib.bind(handler, forcedScope);
				fakeHandler.guid = handler.guid;
				elem.events[type][handler.guid] = forcedScope ? fakeHandler : handler;
			},
			remove: function (elem, type, handler) {
				// handle multiple events
				if (type.indexOf(' ') > -1) {
					var eventList = type.split(' ');
					for (var i = 0; i < eventList.length; i++) {
						publicAPI.remove(elem, eventList[i], handler);
					}
					return;
				}

				var handlers = elem.events && elem.events[type];
				if (!handlers) return;
				delete handlers[handler.guid];
				for (var any in handlers) return;
				if (elem.removeEventListener) elem.removeEventListener(type, elem.handle, false);
				else if (elem.detachEvent) elem.detachEvent("on" + type, elem.handle);
				delete elem.events[type];
				for (var any in elem.events) return;
				try {
					delete elem.handle;
					delete elem.events;
				} catch (e) {
					if (elem.removeAttribute) {
						elem.removeAttribute("handle");
						elem.removeAttribute("events");
					}
				}
				if (type === 'mousewheel') {
					publicAPI.remove(elem, 'DOMMouseScroll', handler);
				}
			}
		}
		return publicAPI;
	}())
}

// custom select module
jcf.addModule({
	name: 'select',
	selector: 'select',
	defaultOptions: {
		useNativeDropOnMobileDevices: true,
		hideDropOnScroll: true,
		showNativeDrop: false,
		handleDropPosition: false,
		selectDropPosition: 'bottom', // or 'top'
		wrapperClass: 'select-area',
		focusClass: 'select-focus',
		dropActiveClass: 'select-active',
		selectedClass: 'item-selected',
		currentSelectedClass: 'current-selected',
		disabledClass: 'select-disabled',
		valueSelector: 'span.center',
		optGroupClass: 'optgroup',
		openerSelector: 'a.select-opener',
		selectStructure: '<span class="left"></span><span class="center"></span><a class="select-opener"></a>',
		wrapperTag: 'span',
		classPrefix: 'select-',
		dropMaxHeight: 200,
		dropFlippedClass: 'select-options-flipped',
		dropHiddenClass: 'options-hidden',
		dropScrollableClass: 'options-overflow',
		dropClass: 'select-options',
		dropClassPrefix: 'drop-',
		dropStructure: '<div class="drop-holder"><div class="drop-list"></div></div>',
		dropSelector: 'div.drop-list'
	},
	checkElement: function (el) {
		return (!el.size && !el.multiple);
	},
	setupWrapper: function () {
		jcf.lib.addClass(this.fakeElement, this.options.wrapperClass);
		this.realElement.parentNode.insertBefore(this.fakeElement, this.realElement.nextSibling);
		this.fakeElement.innerHTML = this.options.selectStructure;
		this.fakeElement.style.width = (this.realElement.offsetWidth > 0 ? this.realElement.offsetWidth + 'px' : 'auto');

		// show native drop if specified in options
		if (this.options.useNativeDropOnMobileDevices && (jcf.isTouchDevice || jcf.isWinPhoneDevice)) {
			this.options.showNativeDrop = true;
		}
		if (this.options.showNativeDrop) {
			this.fakeElement.appendChild(this.realElement);
			jcf.lib.removeClass(this.realElement, this.options.hiddenClass);
			jcf.lib.setStyles(this.realElement, {
				top: 0,
				left: 0,
				margin: 0,
				padding: 0,
				opacity: 0,
				border: 'none',
				position: 'absolute',
				width: jcf.lib.getInnerWidth(this.fakeElement) - 1,
				height: jcf.lib.getInnerHeight(this.fakeElement) - 1
			});
			jcf.lib.event.add(this.realElement, jcf.eventPress, function () {
				this.realElement.title = '';
			}, this)
		}

		// create select body
		this.opener = jcf.lib.queryBySelector(this.options.openerSelector, this.fakeElement)[0];
		this.valueText = jcf.lib.queryBySelector(this.options.valueSelector, this.fakeElement)[0];
		jcf.lib.disableTextSelection(this.valueText);
		this.opener.jcf = this;

		if (!this.options.showNativeDrop) {
			this.createDropdown();
			this.refreshState();
			this.onControlReady(this);
			this.hideDropdown();
		} else {
			this.refreshState();
		}
		this.addEvents();
	},
	addEvents: function () {
		if (this.options.showNativeDrop) {
			jcf.lib.event.add(this.realElement, 'click', this.onChange, this);
		} else {
			jcf.lib.event.add(this.fakeElement, 'click', this.toggleDropdown, this);
		}
		jcf.lib.event.add(this.realElement, 'change', this.onChange, this);
	},
	onFakeClick: function () {
		// do nothing (drop toggles by toggleDropdown method)
	},
	onFocus: function () {
		jcf.modules[this.name].superclass.onFocus.apply(this, arguments);
		if (!this.options.showNativeDrop) {
			// Mac Safari Fix
			if (jcf.lib.browser.safariMac) {
				this.realElement.setAttribute('size', '2');
			}
			jcf.lib.event.add(this.realElement, 'keydown', this.onKeyDown, this);
			if (jcf.activeControl && jcf.activeControl != this) {
				jcf.activeControl.hideDropdown();
				jcf.activeControl = this;
			}
		}
	},
	onBlur: function () {
		if (!this.options.showNativeDrop) {
			// Mac Safari Fix
			if (jcf.lib.browser.safariMac) {
				this.realElement.removeAttribute('size');
			}
			if (!this.isActiveDrop() || !this.isOverDrop()) {
				jcf.modules[this.name].superclass.onBlur.apply(this);
				if (jcf.activeControl === this) jcf.activeControl = null;
				if (!jcf.isTouchDevice) {
					this.hideDropdown();
				}
			}
			jcf.lib.event.remove(this.realElement, 'keydown', this.onKeyDown);
		} else {
			jcf.modules[this.name].superclass.onBlur.apply(this);
		}
	},
	onChange: function () {
		this.refreshState();
	},
	onKeyDown: function (e) {
		this.dropOpened = true;
		jcf.tmpFlag = true;
		setTimeout(function () { jcf.tmpFlag = false }, 100);
		var context = this;
		context.keyboardFix = true;
		setTimeout(function () {
			context.refreshState();
		}, 10);
		if (e.keyCode == 13) {
			context.toggleDropdown.apply(context);
			return false;
		}
	},
	onResizeWindow: function (e) {
		if (this.isActiveDrop()) {
			this.hideDropdown();
		}
	},
	onScrollWindow: function (e) {
		if (this.options.hideDropOnScroll) {
			this.hideDropdown();
		} else if (this.isActiveDrop()) {
			this.positionDropdown();
		}
	},
	onOptionClick: function (e) {
		var opener = e.target && e.target.tagName && e.target.tagName.toLowerCase() == 'li' ? e.target : jcf.lib.getParent(e.target, 'li');
		if (opener) {
			this.dropOpened = true;
			this.realElement.selectedIndex = parseInt(opener.getAttribute('rel'));
			if (jcf.isTouchDevice) {
				this.onFocus();
			} else {
				this.realElement.focus();
			}
			this.refreshState();
			this.hideDropdown();
			jcf.lib.fireEvent(this.realElement, 'change');
		}
		return false;
	},
	onClickOutside: function (e) {
		if (jcf.tmpFlag) {
			jcf.tmpFlag = false;
			return;
		}
		if (!jcf.lib.isParent(this.fakeElement, e.target) && !jcf.lib.isParent(this.selectDrop, e.target)) {
			this.hideDropdown();
		}
	},
	onDropHover: function (e) {
		if (!this.keyboardFix) {
			this.hoverFlag = true;
			var opener = e.target && e.target.tagName && e.target.tagName.toLowerCase() == 'li' ? e.target : jcf.lib.getParent(e.target, 'li');
			if (opener) {
				this.realElement.selectedIndex = parseInt(opener.getAttribute('rel'));
				this.refreshSelectedClass(parseInt(opener.getAttribute('rel')));
			}
		} else {
			this.keyboardFix = false;
		}
	},
	onDropLeave: function () {
		this.hoverFlag = false;
	},
	isActiveDrop: function () {
		return !jcf.lib.hasClass(this.selectDrop, this.options.dropHiddenClass);
	},
	isOverDrop: function () {
		return this.hoverFlag;
	},
	createDropdown: function () {
		// remove old dropdown if exists
		if (this.selectDrop && this.selectDrop.parentNode) {
			this.selectDrop.parentNode.removeChild(this.selectDrop);
		}

		// create dropdown holder
		this.selectDrop = document.createElement('div');
		this.selectDrop.className = this.options.dropClass;
		this.selectDrop.innerHTML = this.options.dropStructure;
		jcf.lib.setStyles(this.selectDrop, { position: 'absolute' });
		this.selectList = jcf.lib.queryBySelector(this.options.dropSelector, this.selectDrop)[0];
		jcf.lib.addClass(this.selectDrop, this.options.dropHiddenClass);
		document.body.appendChild(this.selectDrop);
		this.selectDrop.jcf = this;
		jcf.lib.event.add(this.selectDrop, 'click', this.onOptionClick, this);
		jcf.lib.event.add(this.selectDrop, 'mouseover', this.onDropHover, this);
		jcf.lib.event.add(this.selectDrop, 'mouseout', this.onDropLeave, this);
		this.buildDropdown();
	},
	buildDropdown: function () {
		// build select options / optgroups
		this.buildDropdownOptions();

		// position and resize dropdown
		this.positionDropdown();

		// cut dropdown if height exceedes
		this.buildDropdownScroll();
	},
	buildDropdownOptions: function () {
		this.resStructure = '';
		this.optNum = 0;
		for (var i = 0; i < this.realElement.children.length; i++) {
			this.resStructure += this.buildElement(this.realElement.children[i], i) + '\n';
		}
		this.selectList.innerHTML = this.resStructure;
	},
	buildDropdownScroll: function () {
		jcf.lib.addClass(this.selectDrop, jcf.lib.getAllClasses(this.realElement.className, this.options.dropClassPrefix, jcf.baseOptions.hiddenClass));
		if (this.options.dropMaxHeight) {
			if (this.selectDrop.offsetHeight > this.options.dropMaxHeight) {
				this.selectList.style.height = this.options.dropMaxHeight + 'px';
				this.selectList.style.overflow = 'auto';
				this.selectList.style.overflowX = 'hidden';
				jcf.lib.addClass(this.selectDrop, this.options.dropScrollableClass);
			}
		}
	},
	parseOptionTitle: function (optTitle) {
		return (typeof optTitle === 'string' && /\.(jpg|gif|png|bmp|jpeg)(.*)?$/i.test(optTitle)) ? optTitle : '';
	},
	buildElement: function (obj, index) {
		// build option
		var res = '', optImage;
		if (obj.tagName.toLowerCase() == 'option') {
			if (!jcf.lib.prevSibling(obj) || jcf.lib.prevSibling(obj).tagName.toLowerCase() != 'option') {
				res += '<ul>';
			}

			optImage = this.parseOptionTitle(obj.title);
			res += '<li rel="' + (this.optNum++) + '" class="' + (obj.className ? obj.className + ' ' : '') + (index % 2 ? 'option-even ' : '') + 'jcfcalc"><a href="#">' + (optImage ? '<img src="' + optImage + '" alt="" />' : '') + '<span>' + obj.innerHTML + '</span></a></li>';
			if (!jcf.lib.nextSibling(obj) || jcf.lib.nextSibling(obj).tagName.toLowerCase() != 'option') {
				res += '</ul>';
			}
			return res;
		}
		// build option group with options
		else if (obj.tagName.toLowerCase() == 'optgroup' && obj.label) {
			res += '<div class="' + this.options.optGroupClass + '">';
			res += '<strong class="jcfcalc"><em>' + (obj.label) + '</em></strong>';
			for (var i = 0; i < obj.children.length; i++) {
				res += this.buildElement(obj.children[i], i);
			}
			res += '</div>';
			return res;
		}
	},
	positionDropdown: function () {
		var ofs = jcf.lib.getOffset(this.fakeElement), selectAreaHeight = this.fakeElement.offsetHeight, selectDropHeight = this.selectDrop.offsetHeight;
		var fitInTop = ofs.top - selectDropHeight >= jcf.lib.getScrollTop() && jcf.lib.getScrollTop() + jcf.lib.getWindowHeight() < ofs.top + selectAreaHeight + selectDropHeight;


		if ((this.options.handleDropPosition && fitInTop) || this.options.selectDropPosition === 'top') {
			this.selectDrop.style.top = (ofs.top - selectDropHeight) + 'px';
			jcf.lib.addClass(this.selectDrop, this.options.dropFlippedClass);
			jcf.lib.addClass(this.fakeElement, this.options.dropFlippedClass);
		} else {
			this.selectDrop.style.top = (ofs.top + selectAreaHeight) + 'px';
			jcf.lib.removeClass(this.selectDrop, this.options.dropFlippedClass);
			jcf.lib.removeClass(this.fakeElement, this.options.dropFlippedClass);
		}
		this.selectDrop.style.left = ofs.left + 'px';
		this.selectDrop.style.width = this.fakeElement.offsetWidth + 'px';
	},
	showDropdown: function () {
		document.body.appendChild(this.selectDrop);
		jcf.lib.removeClass(this.selectDrop, this.options.dropHiddenClass);
		jcf.lib.addClass(this.fakeElement, this.options.dropActiveClass);
		this.positionDropdown();

		// highlight current active item
		var activeItem = this.getFakeActiveOption();
		this.removeClassFromItems(this.options.currentSelectedClass);
		jcf.lib.addClass(activeItem, this.options.currentSelectedClass);

		// show current dropdown
		jcf.lib.event.add(window, 'resize', this.onResizeWindow, this);
		jcf.lib.event.add(window, 'scroll', this.onScrollWindow, this);
		jcf.lib.event.add(document, jcf.eventPress, this.onClickOutside, this);
		this.positionDropdown();
	},
	hideDropdown: function () {
		if (this.selectDrop.parentNode) {
			this.selectDrop.parentNode.removeChild(this.selectDrop);
		}
		if (typeof this.origSelectedIndex === 'number') {
			this.realElement.selectedIndex = this.origSelectedIndex;
		}
		jcf.lib.removeClass(this.fakeElement, this.options.dropActiveClass);
		jcf.lib.addClass(this.selectDrop, this.options.dropHiddenClass);
		jcf.lib.event.remove(window, 'resize', this.onResizeWindow);
		jcf.lib.event.remove(window, 'scroll', this.onScrollWindow);
		jcf.lib.event.remove(document.documentElement, jcf.eventPress, this.onClickOutside);
		if (jcf.isTouchDevice) {
			this.onBlur();
		}
	},
	toggleDropdown: function () {
		if (!this.realElement.disabled && this.realElement.options.length) {
			if (jcf.isTouchDevice) {
				this.onFocus();
			} else {
				this.realElement.focus();
			}
			if (this.isActiveDrop()) {
				this.hideDropdown();
			} else {
				this.showDropdown();
			}
			this.refreshState();
		}
	},
	scrollToItem: function () {
		if (this.isActiveDrop()) {
			var dropHeight = this.selectList.offsetHeight;
			var offsetTop = this.calcOptionOffset(this.getFakeActiveOption());
			var sTop = this.selectList.scrollTop;
			var oHeight = this.getFakeActiveOption().offsetHeight;
			//offsetTop+=sTop;

			if (offsetTop >= sTop + dropHeight) {
				this.selectList.scrollTop = offsetTop - dropHeight + oHeight;
			} else if (offsetTop < sTop) {
				this.selectList.scrollTop = offsetTop;
			}
		}
	},
	getFakeActiveOption: function (c) {
		return jcf.lib.queryBySelector('li[rel="' + (typeof c === 'number' ? c : this.realElement.selectedIndex) + '"]', this.selectList)[0];
	},
	calcOptionOffset: function (fake) {
		var h = 0;
		var els = jcf.lib.queryBySelector('.jcfcalc', this.selectList);
		for (var i = 0; i < els.length; i++) {
			if (els[i] == fake) break;
			h += els[i].offsetHeight;
		}
		return h;
	},
	childrenHasItem: function (hold, item) {
		var items = hold.getElementsByTagName('*');
		for (i = 0; i < items.length; i++) {
			if (items[i] == item) return true;
		}
		return false;
	},
	removeClassFromItems: function (className) {
		var children = jcf.lib.queryBySelector('li', this.selectList);
		for (var i = children.length - 1; i >= 0; i--) {
			jcf.lib.removeClass(children[i], className);
		}
	},
	setSelectedClass: function (c) {
		var activeOption = this.getFakeActiveOption(c);
		if (activeOption) {
			jcf.lib.addClass(activeOption, this.options.selectedClass);
		}
	},
	refreshSelectedClass: function (c) {
		if (!this.options.showNativeDrop) {
			this.removeClassFromItems(this.options.selectedClass);
			this.setSelectedClass(c);
		}
		if (this.realElement.disabled) {
			jcf.lib.addClass(this.fakeElement, this.options.disabledClass);
			if (this.labelFor) {
				jcf.lib.addClass(this.labelFor, this.options.labelDisabledClass);
			}
		} else {
			jcf.lib.removeClass(this.fakeElement, this.options.disabledClass);
			if (this.labelFor) {
				jcf.lib.removeClass(this.labelFor, this.options.labelDisabledClass);
			}
		}
	},
	refreshSelectedText: function () {
		if (!this.dropOpened && this.realElement.title) {
			this.valueText.innerHTML = this.realElement.title;
		} else {
			var activeOption = this.realElement.options[this.realElement.selectedIndex];
			if (activeOption) {
				if (activeOption.title) {
					var optImage = this.parseOptionTitle(this.realElement.options[this.realElement.selectedIndex].title);
					this.valueText.innerHTML = (optImage ? '<img src="' + optImage + '" alt="" />' : '') + this.realElement.options[this.realElement.selectedIndex].innerHTML;
				} else {
					this.valueText.innerHTML = this.realElement.options[this.realElement.selectedIndex].innerHTML;
				}
			}
		}

		var selectedOption = this.realElement.options[this.realElement.selectedIndex];
		if (selectedOption && selectedOption.className) {
			this.fakeElement.setAttribute('data-option-class', jcf.lib.getAllClasses(selectedOption.className, 'option-').replace(/^\s+|\s+$/g, ''));
		} else {
			this.fakeElement.removeAttribute('data-option-class');
		}
	},
	refreshState: function () {
		this.origSelectedIndex = this.realElement.selectedIndex;
		this.refreshSelectedClass();
		this.refreshSelectedText();
		if (!this.options.showNativeDrop) {
			this.positionDropdown();
			if (this.selectDrop.offsetWidth) {
				this.scrollToItem();
			}
		}
	}
});


// navigation accesibility module
function TouchNav(opt) {
	this.options = {
		hoverClass: 'hover',
		menuItems: 'li',
		menuOpener: 'a',
		menuDrop: 'ul',
		navBlock: null
	};
	for (var p in opt) {
		if (opt.hasOwnProperty(p)) {
			this.options[p] = opt[p];
		}
	}
	this.init();
}
TouchNav.isActiveOn = function (elem) {
	return elem && elem.touchNavActive;
};
TouchNav.prototype = {
	init: function () {
		if (typeof this.options.navBlock === 'string') {
			this.menu = document.getElementById(this.options.navBlock);
		} else if (typeof this.options.navBlock === 'object') {
			this.menu = this.options.navBlock;
		}
		if (this.menu) {
			this.addEvents();
		}
	},
	addEvents: function () {
		// attach event handlers
		var self = this;
		var touchEvent = (navigator.pointerEnabled && 'pointerdown') || (navigator.msPointerEnabled && 'MSPointerDown') || (this.isTouchDevice && 'touchstart');
		this.menuItems = lib.queryElementsBySelector(this.options.menuItems, this.menu);

		var initMenuItem = function (item) {
			var currentDrop = lib.queryElementsBySelector(self.options.menuDrop, item)[0],
				currentOpener = lib.queryElementsBySelector(self.options.menuOpener, item)[0];

			// only for touch input devices
			if (currentDrop && currentOpener && (self.isTouchDevice || self.isPointerDevice)) {
				lib.event.add(currentOpener, 'click', lib.bind(self.clickHandler, self));
				lib.event.add(currentOpener, 'mousedown', lib.bind(self.mousedownHandler, self));
				lib.event.add(currentOpener, touchEvent, function (e) {
					if (!self.isTouchPointerEvent(e)) {
						self.preventCurrentClick = false;
						return;
					}
					self.touchFlag = true;
					self.currentItem = item;
					self.currentLink = currentOpener;
					self.pressHandler.apply(self, arguments);
				});
			}
			// for desktop computers and touch devices
			jQuery(item).bind('mouseenter', function () {
				if (!self.touchFlag) {
					self.currentItem = item;
					self.mouseoverHandler();
				}
			});
			jQuery(item).bind('mouseleave', function () {
				if (!self.touchFlag) {
					self.currentItem = item;
					self.mouseoutHandler();
				}
			});
			item.touchNavActive = true;
		};

		// addd handlers for all menu items
		for (var i = 0; i < this.menuItems.length; i++) {
			initMenuItem(self.menuItems[i]);
		}

		// hide dropdowns when clicking outside navigation
		if (this.isTouchDevice || this.isPointerDevice) {
			lib.event.add(document.documentElement, 'mousedown', lib.bind(this.clickOutsideHandler, this));
			lib.event.add(document.documentElement, touchEvent, lib.bind(this.clickOutsideHandler, this));
		}
	},
	mousedownHandler: function (e) {
		if (this.touchFlag) {
			e.preventDefault();
			this.touchFlag = false;
			this.preventCurrentClick = false;
		}
	},
	mouseoverHandler: function () {
		lib.addClass(this.currentItem, this.options.hoverClass);
		jQuery(this.currentItem).trigger('itemhover');
	},
	mouseoutHandler: function () {
		lib.removeClass(this.currentItem, this.options.hoverClass);
		jQuery(this.currentItem).trigger('itemleave');
	},
	hideActiveDropdown: function () {
		for (var i = 0; i < this.menuItems.length; i++) {
			if (lib.hasClass(this.menuItems[i], this.options.hoverClass)) {
				lib.removeClass(this.menuItems[i], this.options.hoverClass);
				jQuery(this.menuItems[i]).trigger('itemleave');
			}
		}
		this.activeParent = null;
	},
	pressHandler: function (e) {
		// hide previous drop (if active)
		if (this.currentItem !== this.activeParent) {
			if (this.activeParent && this.currentItem.parentNode === this.activeParent.parentNode) {
				lib.removeClass(this.activeParent, this.options.hoverClass);
			} else if (!this.isParent(this.activeParent, this.currentLink)) {
				this.hideActiveDropdown();
			}
		}
		// handle current drop
		this.activeParent = this.currentItem;
		if (lib.hasClass(this.currentItem, this.options.hoverClass)) {
			this.preventCurrentClick = false;
		} else {
			e.preventDefault();
			this.preventCurrentClick = true;
			lib.addClass(this.currentItem, this.options.hoverClass);
			jQuery(this.currentItem).trigger('itemhover');
		}
	},
	clickHandler: function (e) {
		// prevent first click on link
		if (this.preventCurrentClick) {
			e.preventDefault();
		}
	},
	clickOutsideHandler: function (event) {
		var e = event.changedTouches ? event.changedTouches[0] : event;
		if (this.activeParent && !this.isParent(this.menu, e.target)) {
			this.hideActiveDropdown();
			this.touchFlag = false;
		}
	},
	isParent: function (parent, child) {
		while (child.parentNode) {
			if (child.parentNode == parent) {
				return true;
			}
			child = child.parentNode;
		}
		return false;
	},
	isTouchPointerEvent: function (e) {
		return (e.type.indexOf('touch') > -1) ||
			(navigator.pointerEnabled && e.pointerType === 'touch') ||
			(navigator.msPointerEnabled && e.pointerType == e.MSPOINTER_TYPE_TOUCH);
	},
	isPointerDevice: (function () {
		return !!(navigator.pointerEnabled || navigator.msPointerEnabled);
	}()),
	isTouchDevice: (function () {
		return !!(('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch);
	}())
};

/*
 * Utility module
 */
lib = {
	hasClass: function (el, cls) {
		return el && el.className ? el.className.match(new RegExp('(\\s|^)' + cls + '(\\s|$)')) : false;
	},
	addClass: function (el, cls) {
		if (el && !this.hasClass(el, cls)) el.className += " " + cls;
	},
	removeClass: function (el, cls) {
		if (el && this.hasClass(el, cls)) { el.className = el.className.replace(new RegExp('(\\s|^)' + cls + '(\\s|$)'), ' '); }
	},
	extend: function (obj) {
		for (var i = 1; i < arguments.length; i++) {
			for (var p in arguments[i]) {
				if (arguments[i].hasOwnProperty(p)) {
					obj[p] = arguments[i][p];
				}
			}
		}
		return obj;
	},
	each: function (obj, callback) {
		var property, len;
		if (typeof obj.length === 'number') {
			for (property = 0, len = obj.length; property < len; property++) {
				if (callback.call(obj[property], property, obj[property]) === false) {
					break;
				}
			}
		} else {
			for (property in obj) {
				if (obj.hasOwnProperty(property)) {
					if (callback.call(obj[property], property, obj[property]) === false) {
						break;
					}
				}
			}
		}
	},
	event: (function () {
		var fixEvent = function (e) {
			e = e || window.event;
			if (e.isFixed) return e; else e.isFixed = true;
			if (!e.target) e.target = e.srcElement;
			e.preventDefault = e.preventDefault || function () { this.returnValue = false; };
			e.stopPropagation = e.stopPropagation || function () { this.cancelBubble = true; };
			return e;
		};
		return {
			add: function (elem, event, handler) {
				if (!elem.events) {
					elem.events = {};
					elem.handle = function (e) {
						var ret, handlers = elem.events[e.type];
						e = fixEvent(e);
						for (var i = 0, len = handlers.length; i < len; i++) {
							if (handlers[i]) {
								ret = handlers[i].call(elem, e);
								if (ret === false) {
									e.preventDefault();
									e.stopPropagation();
								}
							}
						}
					};
				}
				if (!elem.events[event]) {
					elem.events[event] = [];
					if (elem.addEventListener) elem.addEventListener(event, elem.handle, false);
					else if (elem.attachEvent) elem.attachEvent('on' + event, elem.handle);
				}
				elem.events[event].push(handler);
			},
			remove: function (elem, event, handler) {
				var handlers = elem.events[event];
				for (var i = handlers.length - 1; i >= 0; i--) {
					if (handlers[i] === handler) {
						handlers.splice(i, 1);
					}
				}
				if (!handlers.length) {
					delete elem.events[event];
					if (elem.removeEventListener) elem.removeEventListener(event, elem.handle, false);
					else if (elem.detachEvent) elem.detachEvent('on' + event, elem.handle);
				}
			}
		};
	}()),
	queryElementsBySelector: function (selector, scope) {
		scope = scope || document;
		if (!selector) return [];
		if (selector === '>*') return scope.children;
		if (typeof document.querySelectorAll === 'function') {
			return scope.querySelectorAll(selector);
		}
		var selectors = selector.split(',');
		var resultList = [];
		for (var s = 0; s < selectors.length; s++) {
			var currentContext = [scope || document];
			var tokens = selectors[s].replace(/^\s+/, '').replace(/\s+$/, '').split(' ');
			for (var i = 0; i < tokens.length; i++) {
				token = tokens[i].replace(/^\s+/, '').replace(/\s+$/, '');
				if (token.indexOf('#') > -1) {
					var bits = token.split('#'), tagName = bits[0], id = bits[1];
					var element = document.getElementById(id);
					if (element && tagName && element.nodeName.toLowerCase() != tagName) {
						return [];
					}
					currentContext = element ? [element] : [];
					continue;
				}
				if (token.indexOf('.') > -1) {
					var bits = token.split('.'), tagName = bits[0] || '*', className = bits[1], found = [], foundCount = 0;
					for (var h = 0; h < currentContext.length; h++) {
						var elements;
						if (tagName == '*') {
							elements = currentContext[h].getElementsByTagName('*');
						} else {
							elements = currentContext[h].getElementsByTagName(tagName);
						}
						for (var j = 0; j < elements.length; j++) {
							found[foundCount++] = elements[j];
						}
					}
					currentContext = [];
					var currentContextIndex = 0;
					for (var k = 0; k < found.length; k++) {
						if (found[k].className && found[k].className.match(new RegExp('(\\s|^)' + className + '(\\s|$)'))) {
							currentContext[currentContextIndex++] = found[k];
						}
					}
					continue;
				}
				if (token.match(/^(\w*)\[(\w+)([=~\|\^\$\*]?)=?"?([^\]"]*)"?\]$/)) {
					var tagName = RegExp.$1 || '*', attrName = RegExp.$2, attrOperator = RegExp.$3, attrValue = RegExp.$4;
					if (attrName.toLowerCase() == 'for' && this.browser.msie && this.browser.version < 8) {
						attrName = 'htmlFor';
					}
					var found = [], foundCount = 0;
					for (var h = 0; h < currentContext.length; h++) {
						var elements;
						if (tagName == '*') {
							elements = currentContext[h].getElementsByTagName('*');
						} else {
							elements = currentContext[h].getElementsByTagName(tagName);
						}
						for (var j = 0; elements[j]; j++) {
							found[foundCount++] = elements[j];
						}
					}
					currentContext = [];
					var currentContextIndex = 0, checkFunction;
					switch (attrOperator) {
						case '=': checkFunction = function (e) { return (e.getAttribute(attrName) == attrValue) }; break;
						case '~': checkFunction = function (e) { return (e.getAttribute(attrName).match(new RegExp('(\\s|^)' + attrValue + '(\\s|$)'))) }; break;
						case '|': checkFunction = function (e) { return (e.getAttribute(attrName).match(new RegExp('^' + attrValue + '-?'))) }; break;
						case '^': checkFunction = function (e) { return (e.getAttribute(attrName).indexOf(attrValue) == 0) }; break;
						case '$': checkFunction = function (e) { return (e.getAttribute(attrName).lastIndexOf(attrValue) == e.getAttribute(attrName).length - attrValue.length) }; break;
						case '*': checkFunction = function (e) { return (e.getAttribute(attrName).indexOf(attrValue) > -1) }; break;
						default: checkFunction = function (e) { return e.getAttribute(attrName) };
					}
					currentContext = [];
					var currentContextIndex = 0;
					for (var k = 0; k < found.length; k++) {
						if (checkFunction(found[k])) {
							currentContext[currentContextIndex++] = found[k];
						}
					}
					continue;
				}
				tagName = token;
				var found = [], foundCount = 0;
				for (var h = 0; h < currentContext.length; h++) {
					var elements = currentContext[h].getElementsByTagName(tagName);
					for (var j = 0; j < elements.length; j++) {
						found[foundCount++] = elements[j];
					}
				}
				currentContext = found;
			}
			resultList = [].concat(resultList, currentContext);
		}
		return resultList;
	},
	trim: function (str) {
		return str.replace(/^\s+/, '').replace(/\s+$/, '');
	},
	bind: function (f, scope, forceArgs) {
		return function () { return f.apply(scope, typeof forceArgs !== 'undefined' ? [forceArgs] : arguments); };
	}
};

/*! Hammer.JS - v1.1.3 - 2014-05-20
 * http://eightmedia.github.io/hammer.js
 *
 * Copyright (c) 2014 Jorik Tangelder <j.tangelder@gmail.com>;
 * Licensed under the MIT license */
!function (a, b) { "use strict"; function c() { d.READY || (s.determineEventTypes(), r.each(d.gestures, function (a) { u.register(a) }), s.onTouch(d.DOCUMENT, n, u.detect), s.onTouch(d.DOCUMENT, o, u.detect), d.READY = !0) } var d = function v(a, b) { return new v.Instance(a, b || {}) }; d.VERSION = "1.1.3", d.defaults = { behavior: { userSelect: "none", touchAction: "pan-y", touchCallout: "none", contentZooming: "none", userDrag: "none", tapHighlightColor: "rgba(0,0,0,0)" } }, d.DOCUMENT = document, d.HAS_POINTEREVENTS = navigator.pointerEnabled || navigator.msPointerEnabled, d.HAS_TOUCHEVENTS = "ontouchstart" in a, d.IS_MOBILE = /mobile|tablet|ip(ad|hone|od)|android|silk/i.test(navigator.userAgent), d.NO_MOUSEEVENTS = d.HAS_TOUCHEVENTS && d.IS_MOBILE || d.HAS_POINTEREVENTS, d.CALCULATE_INTERVAL = 25; var e = {}, f = d.DIRECTION_DOWN = "down", g = d.DIRECTION_LEFT = "left", h = d.DIRECTION_UP = "up", i = d.DIRECTION_RIGHT = "right", j = d.POINTER_MOUSE = "mouse", k = d.POINTER_TOUCH = "touch", l = d.POINTER_PEN = "pen", m = d.EVENT_START = "start", n = d.EVENT_MOVE = "move", o = d.EVENT_END = "end", p = d.EVENT_RELEASE = "release", q = d.EVENT_TOUCH = "touch"; d.READY = !1, d.plugins = d.plugins || {}, d.gestures = d.gestures || {}; var r = d.utils = { extend: function (a, c, d) { for (var e in c) !c.hasOwnProperty(e) || a[e] !== b && d || (a[e] = c[e]); return a }, on: function (a, b, c) { a.addEventListener(b, c, !1) }, off: function (a, b, c) { a.removeEventListener(b, c, !1) }, each: function (a, c, d) { var e, f; if ("forEach" in a) a.forEach(c, d); else if (a.length !== b) { for (e = 0, f = a.length; f > e; e++)if (c.call(d, a[e], e, a) === !1) return } else for (e in a) if (a.hasOwnProperty(e) && c.call(d, a[e], e, a) === !1) return }, inStr: function (a, b) { return a.indexOf(b) > -1 }, inArray: function (a, b) { if (a.indexOf) { var c = a.indexOf(b); return -1 === c ? !1 : c } for (var d = 0, e = a.length; e > d; d++)if (a[d] === b) return d; return !1 }, toArray: function (a) { return Array.prototype.slice.call(a, 0) }, hasParent: function (a, b) { for (; a;) { if (a == b) return !0; a = a.parentNode } return !1 }, getCenter: function (a) { var b = [], c = [], d = [], e = [], f = Math.min, g = Math.max; return 1 === a.length ? { pageX: a[0].pageX, pageY: a[0].pageY, clientX: a[0].clientX, clientY: a[0].clientY } : (r.each(a, function (a) { b.push(a.pageX), c.push(a.pageY), d.push(a.clientX), e.push(a.clientY) }), { pageX: (f.apply(Math, b) + g.apply(Math, b)) / 2, pageY: (f.apply(Math, c) + g.apply(Math, c)) / 2, clientX: (f.apply(Math, d) + g.apply(Math, d)) / 2, clientY: (f.apply(Math, e) + g.apply(Math, e)) / 2 }) }, getVelocity: function (a, b, c) { return { x: Math.abs(b / a) || 0, y: Math.abs(c / a) || 0 } }, getAngle: function (a, b) { var c = b.clientX - a.clientX, d = b.clientY - a.clientY; return 180 * Math.atan2(d, c) / Math.PI }, getDirection: function (a, b) { var c = Math.abs(a.clientX - b.clientX), d = Math.abs(a.clientY - b.clientY); return c >= d ? a.clientX - b.clientX > 0 ? g : i : a.clientY - b.clientY > 0 ? h : f }, getDistance: function (a, b) { var c = b.clientX - a.clientX, d = b.clientY - a.clientY; return Math.sqrt(c * c + d * d) }, getScale: function (a, b) { return a.length >= 2 && b.length >= 2 ? this.getDistance(b[0], b[1]) / this.getDistance(a[0], a[1]) : 1 }, getRotation: function (a, b) { return a.length >= 2 && b.length >= 2 ? this.getAngle(b[1], b[0]) - this.getAngle(a[1], a[0]) : 0 }, isVertical: function (a) { return a == h || a == f }, setPrefixedCss: function (a, b, c, d) { var e = ["", "Webkit", "Moz", "O", "ms"]; b = r.toCamelCase(b); for (var f = 0; f < e.length; f++) { var g = b; if (e[f] && (g = e[f] + g.slice(0, 1).toUpperCase() + g.slice(1)), g in a.style) { a.style[g] = (null == d || d) && c || ""; break } } }, toggleBehavior: function (a, b, c) { if (b && a && a.style) { r.each(b, function (b, d) { r.setPrefixedCss(a, d, b, c) }); var d = c && function () { return !1 }; "none" == b.userSelect && (a.onselectstart = d), "none" == b.userDrag && (a.ondragstart = d) } }, toCamelCase: function (a) { return a.replace(/[_-]([a-z])/g, function (a) { return a[1].toUpperCase() }) } }, s = d.event = { preventMouseEvents: !1, started: !1, shouldDetect: !1, on: function (a, b, c, d) { var e = b.split(" "); r.each(e, function (b) { r.on(a, b, c), d && d(b) }) }, off: function (a, b, c, d) { var e = b.split(" "); r.each(e, function (b) { r.off(a, b, c), d && d(b) }) }, onTouch: function (a, b, c) { var f = this, g = function (e) { var g, h = e.type.toLowerCase(), i = d.HAS_POINTEREVENTS, j = r.inStr(h, "mouse"); j && f.preventMouseEvents || (j && b == m && 0 === e.button ? (f.preventMouseEvents = !1, f.shouldDetect = !0) : i && b == m ? f.shouldDetect = 1 === e.buttons || t.matchType(k, e) : j || b != m || (f.preventMouseEvents = !0, f.shouldDetect = !0), i && b != o && t.updatePointer(b, e), f.shouldDetect && (g = f.doDetect.call(f, e, b, a, c)), g == o && (f.preventMouseEvents = !1, f.shouldDetect = !1, t.reset()), i && b == o && t.updatePointer(b, e)) }; return this.on(a, e[b], g), g }, doDetect: function (a, b, c, d) { var e = this.getTouchList(a, b), f = e.length, g = b, h = e.trigger, i = f; b == m ? h = q : b == o && (h = p, i = e.length - (a.changedTouches ? a.changedTouches.length : 1)), i > 0 && this.started && (g = n), this.started = !0; var j = this.collectEventData(c, g, e, a); return b != o && d.call(u, j), h && (j.changedLength = i, j.eventType = h, d.call(u, j), j.eventType = g, delete j.changedLength), g == o && (d.call(u, j), this.started = !1), g }, determineEventTypes: function () { var b; return b = d.HAS_POINTEREVENTS ? a.PointerEvent ? ["pointerdown", "pointermove", "pointerup pointercancel lostpointercapture"] : ["MSPointerDown", "MSPointerMove", "MSPointerUp MSPointerCancel MSLostPointerCapture"] : d.NO_MOUSEEVENTS ? ["touchstart", "touchmove", "touchend touchcancel"] : ["touchstart mousedown", "touchmove mousemove", "touchend touchcancel mouseup"], e[m] = b[0], e[n] = b[1], e[o] = b[2], e }, getTouchList: function (a, b) { if (d.HAS_POINTEREVENTS && !(navigator.msPointerEnabled && !navigator.pointerEnabled)) return t.getTouchList(); if (a.touches) { if (b == n) return a.touches; var c = [], e = [].concat(r.toArray(a.touches), r.toArray(a.changedTouches)), f = []; return r.each(e, function (a) { r.inArray(c, a.identifier) === !1 && f.push(a), c.push(a.identifier) }), f } return a.identifier = 1, [a] }, collectEventData: function (a, b, c, d) { var e = k; return r.inStr(d.type, "mouse") || t.matchType(j, d) ? e = j : t.matchType(l, d) && (e = l), { center: r.getCenter(c), timeStamp: Date.now(), target: d.target, touches: c, eventType: b, pointerType: e, srcEvent: d, preventDefault: function () { var a = this.srcEvent; a.preventManipulation && a.preventManipulation(), a.preventDefault && a.preventDefault() }, stopPropagation: function () { this.srcEvent.stopPropagation() }, stopDetect: function () { return u.stopDetect() } } } }, t = d.PointerEvent = { pointers: {}, getTouchList: function () { var a = []; return r.each(this.pointers, function (b) { a.push(b) }), a }, updatePointer: function (a, b) { a == o || a != o && 1 !== b.buttons ? delete this.pointers[b.pointerId] : (b.identifier = b.pointerId, this.pointers[b.pointerId] = b) }, matchType: function (a, b) { if (!b.pointerType) return !1; var c = b.pointerType, d = {}; return d[j] = c === (b.MSPOINTER_TYPE_MOUSE || j), d[k] = c === (b.MSPOINTER_TYPE_TOUCH || k), d[l] = c === (b.MSPOINTER_TYPE_PEN || l), d[a] }, reset: function () { this.pointers = {} } }, u = d.detection = { gestures: [], current: null, previous: null, stopped: !1, startDetect: function (a, b) { this.current || (this.stopped = !1, this.current = { inst: a, startEvent: r.extend({}, b), lastEvent: !1, lastCalcEvent: !1, futureCalcEvent: !1, lastCalcData: {}, name: "" }, this.detect(b)) }, detect: function (a) { if (this.current && !this.stopped) { a = this.extendEventData(a); var b = this.current.inst, c = b.options; return r.each(this.gestures, function (d) { !this.stopped && b.enabled && c[d.name] && d.handler.call(d, a, b) }, this), this.current && (this.current.lastEvent = a), a.eventType == o && this.stopDetect(), a } }, stopDetect: function () { this.previous = r.extend({}, this.current), this.current = null, this.stopped = !0 }, getCalculatedData: function (a, b, c, e, f) { var g = this.current, h = !1, i = g.lastCalcEvent, j = g.lastCalcData; i && a.timeStamp - i.timeStamp > d.CALCULATE_INTERVAL && (b = i.center, c = a.timeStamp - i.timeStamp, e = a.center.clientX - i.center.clientX, f = a.center.clientY - i.center.clientY, h = !0), (a.eventType == q || a.eventType == p) && (g.futureCalcEvent = a), (!g.lastCalcEvent || h) && (j.velocity = r.getVelocity(c, e, f), j.angle = r.getAngle(b, a.center), j.direction = r.getDirection(b, a.center), g.lastCalcEvent = g.futureCalcEvent || a, g.futureCalcEvent = a), a.velocityX = j.velocity.x, a.velocityY = j.velocity.y, a.interimAngle = j.angle, a.interimDirection = j.direction }, extendEventData: function (a) { var b = this.current, c = b.startEvent, d = b.lastEvent || c; (a.eventType == q || a.eventType == p) && (c.touches = [], r.each(a.touches, function (a) { c.touches.push({ clientX: a.clientX, clientY: a.clientY }) })); var e = a.timeStamp - c.timeStamp, f = a.center.clientX - c.center.clientX, g = a.center.clientY - c.center.clientY; return this.getCalculatedData(a, d.center, e, f, g), r.extend(a, { startEvent: c, deltaTime: e, deltaX: f, deltaY: g, distance: r.getDistance(c.center, a.center), angle: r.getAngle(c.center, a.center), direction: r.getDirection(c.center, a.center), scale: r.getScale(c.touches, a.touches), rotation: r.getRotation(c.touches, a.touches) }), a }, register: function (a) { var c = a.defaults || {}; return c[a.name] === b && (c[a.name] = !0), r.extend(d.defaults, c, !0), a.index = a.index || 1e3, this.gestures.push(a), this.gestures.sort(function (a, b) { return a.index < b.index ? -1 : a.index > b.index ? 1 : 0 }), this.gestures } }; d.Instance = function (a, b) { var e = this; c(), this.element = a, this.enabled = !0, r.each(b, function (a, c) { delete b[c], b[r.toCamelCase(c)] = a }), this.options = r.extend(r.extend({}, d.defaults), b || {}), this.options.behavior && r.toggleBehavior(this.element, this.options.behavior, !0), this.eventStartHandler = s.onTouch(a, m, function (a) { e.enabled && a.eventType == m ? u.startDetect(e, a) : a.eventType == q && u.detect(a) }), this.eventHandlers = [] }, d.Instance.prototype = { on: function (a, b) { var c = this; return s.on(c.element, a, b, function (a) { c.eventHandlers.push({ gesture: a, handler: b }) }), c }, off: function (a, b) { var c = this; return s.off(c.element, a, b, function (a) { var d = r.inArray({ gesture: a, handler: b }); d !== !1 && c.eventHandlers.splice(d, 1) }), c }, trigger: function (a, b) { b || (b = {}); var c = d.DOCUMENT.createEvent("Event"); c.initEvent(a, !0, !0), c.gesture = b; var e = this.element; return r.hasParent(b.target, e) && (e = b.target), e.dispatchEvent(c), this }, enable: function (a) { return this.enabled = a, this }, dispose: function () { var a, b; for (r.toggleBehavior(this.element, this.options.behavior, !1), a = -1; b = this.eventHandlers[++a];)r.off(this.element, b.gesture, b.handler); return this.eventHandlers = [], s.off(this.element, e[m], this.eventStartHandler), null } }, function (a) { function b(b, d) { var e = u.current; if (!(d.options.dragMaxTouches > 0 && b.touches.length > d.options.dragMaxTouches)) switch (b.eventType) { case m: c = !1; break; case n: if (b.distance < d.options.dragMinDistance && e.name != a) return; var j = e.startEvent.center; if (e.name != a && (e.name = a, d.options.dragDistanceCorrection && b.distance > 0)) { var k = Math.abs(d.options.dragMinDistance / b.distance); j.pageX += b.deltaX * k, j.pageY += b.deltaY * k, j.clientX += b.deltaX * k, j.clientY += b.deltaY * k, b = u.extendEventData(b) } (e.lastEvent.dragLockToAxis || d.options.dragLockToAxis && d.options.dragLockMinDistance <= b.distance) && (b.dragLockToAxis = !0); var l = e.lastEvent.direction; b.dragLockToAxis && l !== b.direction && (b.direction = r.isVertical(l) ? b.deltaY < 0 ? h : f : b.deltaX < 0 ? g : i), c || (d.trigger(a + "start", b), c = !0), d.trigger(a, b), d.trigger(a + b.direction, b); var q = r.isVertical(b.direction); (d.options.dragBlockVertical && q || d.options.dragBlockHorizontal && !q) && b.preventDefault(); break; case p: c && b.changedLength <= d.options.dragMaxTouches && (d.trigger(a + "end", b), c = !1); break; case o: c = !1 } } var c = !1; d.gestures.Drag = { name: a, index: 50, handler: b, defaults: { dragMinDistance: 10, dragDistanceCorrection: !0, dragMaxTouches: 1, dragBlockHorizontal: !1, dragBlockVertical: !1, dragLockToAxis: !1, dragLockMinDistance: 25 } } }("drag"), d.gestures.Gesture = { name: "gesture", index: 1337, handler: function (a, b) { b.trigger(this.name, a) } }, function (a) { function b(b, d) { var e = d.options, f = u.current; switch (b.eventType) { case m: clearTimeout(c), f.name = a, c = setTimeout(function () { f && f.name == a && d.trigger(a, b) }, e.holdTimeout); break; case n: b.distance > e.holdThreshold && clearTimeout(c); break; case p: clearTimeout(c) } } var c; d.gestures.Hold = { name: a, index: 10, defaults: { holdTimeout: 500, holdThreshold: 2 }, handler: b } }("hold"), d.gestures.Release = { name: "release", index: 1 / 0, handler: function (a, b) { a.eventType == p && b.trigger(this.name, a) } }, d.gestures.Swipe = { name: "swipe", index: 40, defaults: { swipeMinTouches: 1, swipeMaxTouches: 1, swipeVelocityX: .6, swipeVelocityY: .6 }, handler: function (a, b) { if (a.eventType == p) { var c = a.touches.length, d = b.options; if (c < d.swipeMinTouches || c > d.swipeMaxTouches) return; (a.velocityX > d.swipeVelocityX || a.velocityY > d.swipeVelocityY) && (b.trigger(this.name, a), b.trigger(this.name + a.direction, a)) } } }, function (a) { function b(b, d) { var e, f, g = d.options, h = u.current, i = u.previous; switch (b.eventType) { case m: c = !1; break; case n: c = c || b.distance > g.tapMaxDistance; break; case o: !r.inStr(b.srcEvent.type, "cancel") && b.deltaTime < g.tapMaxTime && !c && (e = i && i.lastEvent && b.timeStamp - i.lastEvent.timeStamp, f = !1, i && i.name == a && e && e < g.doubleTapInterval && b.distance < g.doubleTapDistance && (d.trigger("doubletap", b), f = !0), (!f || g.tapAlways) && (h.name = a, d.trigger(h.name, b))) } } var c = !1; d.gestures.Tap = { name: a, index: 100, handler: b, defaults: { tapMaxTime: 250, tapMaxDistance: 10, tapAlways: !0, doubleTapDistance: 20, doubleTapInterval: 300 } } }("tap"), d.gestures.Touch = { name: "touch", index: -1 / 0, defaults: { preventDefault: !1, preventMouse: !1 }, handler: function (a, b) { return b.options.preventMouse && a.pointerType == j ? void a.stopDetect() : (b.options.preventDefault && a.preventDefault(), void (a.eventType == q && b.trigger("touch", a))) } }, function (a) { function b(b, d) { switch (b.eventType) { case m: c = !1; break; case n: if (b.touches.length < 2) return; var e = Math.abs(1 - b.scale), f = Math.abs(b.rotation); if (e < d.options.transformMinScale && f < d.options.transformMinRotation) return; u.current.name = a, c || (d.trigger(a + "start", b), c = !0), d.trigger(a, b), f > d.options.transformMinRotation && d.trigger("rotate", b), e > d.options.transformMinScale && (d.trigger("pinch", b), d.trigger("pinch" + (b.scale < 1 ? "in" : "out"), b)); break; case p: c && b.changedLength < 2 && (d.trigger(a + "end", b), c = !1) } } var c = !1; d.gestures.Transform = { name: a, index: 45, defaults: { transformMinScale: .01, transformMinRotation: 1 }, handler: b } }("transform"), "function" == typeof define && define.amd ? define(function () { return d }) : "undefined" != typeof module && module.exports ? module.exports = d : a.Hammer = d }(window);

/*! matchMedia() polyfill - Test a CSS media type/query in JS. Authors & copyright (c) 2012: Scott Jehl, Paul Irish, Nicholas Zakas. Dual MIT/BSD license */
; window.matchMedia = window.matchMedia || (function (e, f) { var c, a = e.documentElement, b = a.firstElementChild || a.firstChild, d = e.createElement("body"), g = e.createElement("div"); g.id = "mq-test-1"; g.style.cssText = "position:absolute;top:-100em"; d.appendChild(g); return function (h) { g.innerHTML = '&shy;<style media="' + h + '"> #mq-test-1 { width: 42px; }</style>'; a.insertBefore(d, b); c = g.offsetWidth == 42; a.removeChild(d); return { matches: c, media: h } } })(document);

/*! Picturefill - Responsive Images that work today. (and mimic the proposed Picture element with span elements). Author: Scott Jehl, Filament Group, 2012 | License: MIT/GPLv2 */
; (function (a) { a.picturefill = function () { var b = a.document.getElementsByTagName("span"); for (var f = 0, l = b.length; f < l; f++) { if (b[f].getAttribute("data-picture") !== null) { var c = b[f].getElementsByTagName("span"), h = []; for (var e = 0, g = c.length; e < g; e++) { var d = c[e].getAttribute("data-media"); if (!d || (a.matchMedia && a.matchMedia(d).matches)) { h.push(c[e]) } } var m = b[f].getElementsByTagName("img")[0]; if (h.length) { var k = h.pop(); if (!m || m.parentNode.nodeName === "NOSCRIPT") { m = a.document.createElement("img"); m.alt = b[f].getAttribute("data-alt") } if (k.getAttribute("data-width")) { m.setAttribute("width", k.getAttribute("data-width")) } else { m.removeAttribute("width") } if (k.getAttribute("data-height")) { m.setAttribute("height", k.getAttribute("data-height")) } else { m.removeAttribute("height") } m.src = k.getAttribute("data-src"); k.appendChild(m) } else { if (m) { m.parentNode.removeChild(m) } } } } }; if (a.addEventListener) { a.addEventListener("resize", a.picturefill, false); a.addEventListener("DOMContentLoaded", function () { a.picturefill(); a.removeEventListener("load", a.picturefill, false) }, false); a.addEventListener("load", a.picturefill, false) } else { if (a.attachEvent) { a.attachEvent("onload", a.picturefill) } } }(this));