var shiurHTML; //html block for sidebar
var currentPlayingShiur = true;
var playerCreated = false;
var playerCalled = false;
var pauseOtherPlayers = false;
var isCalled = 0;
var totalDuration = 0;
var currentPlayerTime = 0;
var isPlayed = 0;
var lastPlayed = 0;
var playingShiurID = 0;
var queueList = [];
var articlesList = [];
var loginFormValidator;
var playerVideo = '';
var playerImg = '';
var callQueue = false;
var callArticles = false;
var callHistory = false;
var queueGet = 0;
var windowWidth = 0;
var addthisLoaded = 0;
var addthis_config;
var sponsorshipAudioStatus = 0;
var teacherSponsorAudioStatus = 0;
var currentTeacherSponsorIndex = 0; // Track which teacher sponsor is playing
var teacherSponsorAudios = [];
var cal;

// Load all important calls as soon as possible
$(document).ready(function () {
    //return;
    windowWidth = $(window).width();
    //load templates for sidebars
    shiurHTML = $('#sidebar-shiur').html();
    //notify user about sync the player
    initSyncPlayer();
    //load teacher, category, series sidebars
    initAjaxAsideSidebar('.lecture-page .profile-block .teacher, .lecture-page .columns .col .postedin');
    initAjaxAsideSidebar('#sidebar .collection-title');
    //show play/queue/download buttons
    initFeaturedButtons('#home-tabs-area #tab5 .post');
    initFeaturedButtons('.daf-related .post');
    initFeaturedButtons('.lecture-buttons');
    initFeaturedButtons('.lecture-page .tab-holder .list .post');
    //$('#home-tabs-area #tab6 .post').unbind();
    if (playerCalled == false) {
        initSidePlayer();
    }
    // check if firefox, and add class 'firefox' to the html
    Modernizr.addTest('firefox', function () {
        return !!navigator.userAgent.match(/firefox/i);
    });


    //alert('slideshow change');
    //$("#slidesetToReplace").html('<div class="slide">slideshow number one after load</div><div class="slide">slideshow number two after load</div>');
    //$("#carouselToReplace").html('<div class="slide">caoursel one<br />second line</div><div class="slide">caoursel two<br /><br /><br /></div>');

});

$(window).load(function () {
    //load widget data
    loadWidgetContent();
    //fixed position for sponsorship banner
    initFixedBanner();
    //footer google map
    initMap();
    //initAjaxAsideSidebar('#home-tabs-area .textbox .postedin');
    //initAjaxAsideSidebar('#home-tabs-area #tab6 .textbox .title a');
    //load popup for Add to Home
    initShowPopupHome();
    //hide sidebar on click
    initHideAside();

    // Home Page: Share page -- Show lecture sidebar
    initSharePageLectureSidebar($(location).attr('href'));
    // Home Page: Share page -- Show teacher sidebar
    initSharePageTeacherSidebar($(location).attr('href'));
    // Home Page: Share page -- Show category sidebar
    initSharePageCategorySidebar($(location).attr('href'));
    // Home Page: Share page -- Show series sidebar
    initSharePageSeriesSidebar($(location).attr('href'));
    // Home Page: Share page -- Show location sidebar
    initSharePageVenuesSidebar($(location).attr('href'));

    initCustomHover();
    initLoginDropOpener();
    initLoginValidator();
    initSubscribeValidator();

    //get the custom collection content only on scroll and if visible
    initCustomCollectionContent();
    //remove the custom collection content
    //initRemoveCollection();

    if (typeof _maintenanceOverride != 'undefined') {
        if (!_maintenanceOverride) {
            //load queue
            refreshQueue('get', 000000, 'queue', 0, '');
            //refreshQueue('get', 000000, 'articles', 0, '');
            scrollInSidenav();
            searchInHistory('input#searchInHistory');
            //load Queue/Articles/History on button click and Clear All
            initQueue();
        } else {
            // hide events column
            $('.calendar-area').parent().parent().hide();
        }
    } else {
        //load queue
        refreshQueue('get', 000000, 'queue', 0, '');
        //refreshQueue('get', 000000, 'articles', 0, '');
        scrollInSidenav();
        searchInHistory('input#searchInHistory');
        //load Queue/Articles/History on button click and Clear All
        initQueue();
    }

    //open/close panels
    initOpenClose();
    //daf zoom option
    initDafZoomImg();
    //check if user has played shiurs
    isPlayedApplyStyle();
    //coming soon for gears
    //settingBox();
    //load teachers and series
    loadFavorites();
    //multiple teachers image slideshow
    imgSlideShow('.img-holder');
    //landing page add to favories
    addToFavoritesFromLanding();
    //lecture page add to favorites
    addToFavoritesFromLecture();
    //add tooltip for uploaded
    addTooltip($('.post-uploaded').attr('title', 'Uploaded Date'), 'info', 'center', 'right', 'center', 'left');
    //edit shiur link
    editShiur('#home-tabs-area');
    editShiur('.lecture-page .tab-content');
    editShiur('.daf-related');
    // Update the "Timely" section
    // initUpdateTimelySection();
    // update user collections 
    initUpdateHomeCollectionBoxes();
    //lecture page slideshow
    imgSlideShow('.lecture-page .teachers-images', 'lecture');
    // if mobile update layout
    initMobileLayout();

});

//check if touch device
function isTouchDevice() {
    return true == ("ontouchstart" in window || window.DocumentTouch && document instanceof DocumentTouch);
}

//notify user about sync the player
function initSyncPlayer() {
    if (sessionStorage.getItem('playingShiurID') !== null && sessionStorage.getItem('currentTime') !== null /*&& (isMobile() == false)*/) {
        var box = $('.sidenav');
        var player = box.find('.sidenav-player');
        player.addClass('loading');
        var text = '';
        if (isMobile() == false) {
            text += '<div class="added-to-player">Resuming player</div>';
        } else {
            //text += '<div class="added-to-player">Loading player</div>';
            text += '<div></div>';
        }
        $(text).fadeIn('slow').prependTo(box).delay(1000).fadeOut('slow', function () {
            $(this).remove();
            player.removeClass('loading');
        });
    }
}

//based on resolution bind or unbind zoom on daf big image
function dafAttachZoom(zoomImg) {
    zoomImg.zoom({ on: 'grab', touch: true });
    zoomImg.on('touchend', function () {
        zoomImg.trigger('zoom.destroy');
        zoomImg.zoom({ on: 'grab', touch: true });
    });
}

function initDafZoomImg() {
    var zoomImg = $('#zoomImg');
    if (zoomImg.length > 0) {
        ResponsiveHelper.addRange({
            '..670': {
                on: function () {
                    dafAttachZoom(zoomImg);
                },
                off: function () {
                    zoomImg.unbind();
                }
            },
            '670..780': {
                on: function () {
                    dafAttachZoom(zoomImg);
                },
                off: function () {
                    zoomImg.unbind();
                }
            },
            '1024..1166': {
                on: function () {
                    dafAttachZoom(zoomImg);
                },
                off: function () {
                    zoomImg.unbind();
                }
            }
        });
    }
}

// lead to login box
function showLoginPanel(el) {
    if ($(el).length > 0) {
        if (userAuthenticated == 0) {
            // old style of showing login box
            /*if(windowWidth > 1023 && isMobile() == false){
              $(el).on('click touchstart', function () {
                $('#wrap-holder').animate({ scrollTop: 0 }, "slow");
                $('body').addClass('item-active');
                var navLi = $('#nav > ul > li');
                navLi.removeClass('hover');
                navLi.find('> .dropdown').removeClass('hover').hide();
                $('#nav > ul > li > .sub-drop').hide();
                $('.login-area > li:first-child').addClass('hover');
                hideFromViewport('.login-area > li .login-drop', 1, 'hover');
                return false;
             });
           } else {
            $(el).magnificPopup({
              items: {
                src: '.login-drop',
                type: 'inline'
              },
              //closeOnBgClick: false,
              fixedContentPos: true,
              overflowY: 'scroll',
              mainClass: 'login-popup',
              alignTop: true
            });
           }
         }*/
            // new style of showing login box
            if (windowWidth >= 1024) {
                $(el).magnificPopup({
                    items: {
                        src: '.login-drop',
                        type: 'inline'
                    },
                    //closeOnBgClick: false,
                    fixedContentPos: true,
                    overflowY: 'scroll',
                    mainClass: 'login-popup',
                    alignTop: false
                });
            }
            if (windowWidth <= 1023) {
                $(el).magnificPopup({
                    items: {
                        src: '.login-drop',
                        type: 'inline'
                    },
                    //closeOnBgClick: false,
                    fixedContentPos: true,
                    overflowY: 'scroll',
                    mainClass: 'login-popup',
                    alignTop: true
                });
            }
        }
    }
}

// hide element on click outside of it
/*function hideFromViewport(element, parentTrue, elClass){
  var elementContainer;
  if(parentTrue == 1){
    elementContainer = $(element).parent();
  } else {
    elementContainer = $(element);
  }
  setTimeout(function(){
    $('body').on('click touchstart', function(e){
      if($(elementContainer).hasClass(elClass) && !$(e.target).closest(element).length){
        $('body').removeClass('item-active');
        $(elementContainer).removeClass(elClass);
        $('body').off();
      }
    });
    $(element).on('mouseleave', function(e){
      if(!$(e.target).closest('input').is(":focus")){
        $('body').removeClass('item-active');
        $(elementContainer).removeClass(elClass);
        $('body').off();
      }
    });
  }, 250);
}*/

// Admin edit shiur link
var editShiur = function (el, calledFrom) {
    var hasEditPermission = false;
    var shiurIDListEditPermission = '';

    if (typeof userEditPermission != 'undefined') {
        if (typeof userEditPermission['hasEditPermission']) {
            hasEditPermission = userEditPermission['hasEditPermission'];
        }

        if (typeof userEditPermission['shiurIDListEditPermission']) {
            shiurIDListEditPermission = userEditPermission['shiurIDListEditPermission'];
        }
    }

    if ((hasEditPermission && (userAuthenticated == 1) && (isMobile() == false))
        || (!hasEditPermission && (shiurIDListEditPermission != '') && (userAuthenticated == 1) && (isMobile() == false))
    ) {
        // console.info(el + ' ' + el.length);
        // return;                     
        if (el.length > 0) {
            if (calledFrom == 'search') {
                $.each($(el), function () {
                    var shiurID = $(this).find('a').attr('data-id');
                    if ((!hasEditPermission && (shiurIDListEditPermission.indexOf(shiurID) > -1)) || hasEditPermission) {
                        var editLink = $('<a href="#" data-id="' + shiurID + '" class="edit-shiur-link" title="Edit this Shiur"><i class="fa fa-pencil"></i></a>');
                        $(editLink).prependTo($(this));
                    }
                });
            } else if (calledFrom == 'sidebar') {
                var shiurID = $(el).find('.title').attr('data-id');
                if ((!hasEditPermission && (shiurIDListEditPermission.indexOf(shiurID) > -1)) || hasEditPermission) {
                    var editLink = $('<a href="#" data-id="' + shiurID + '" class="edit-shiur-link" title="Edit this Shiur"><i class="fa fa-pencil"></i></a>');
                    $(el).find('.main-title').prepend($(editLink));
                }
            } else {
                $.each($(el + ' .title'), function () {
                    var shiurID = $(this).find('a').attr('data-id');
                    if ((!hasEditPermission && (shiurIDListEditPermission.indexOf(shiurID) > -1)) || hasEditPermission) {
                        var editLink = $('<a href="#" data-id="' + shiurID + '" class="edit-shiur-link" title="Edit this Shiur"><i class="fa fa-pencil"></i></a>');
                        $(this).prepend($(editLink));
                    }
                });
            }
            ($(el).find('.edit-shiur-link')).on('click', function () {
                var shiurID = $(this).attr('data-id');
                //msgAlert('COMING SOON. We are currently working on a new website. Stay tuned for more information.', 'good');
                openAdmin(shiurID);
                return false;
            });
        }
    }
}

// AJAX load content, type HTML or JSON
function ajaxLoadContent(url, contentType, cache, callback) {
    var options = {
        url: url,
        type: 'get',
        dataType: contentType,
        async: true,
        beforeSend: function () {
            //$("#loading").fadeIn('slow', function(){$(this).show()});
        },
        success: function (data) {
            if (typeof callback === 'function') {
                callback(data);
            }
            //$("#loading").fadeOut('slow', function(){$(this).hide()});
        },
        error: function (jqXHR, exception) {
            ajaxErrorHandler(jqXHR, exception);
        }
    };

    if (cache === true) {
        options['cache'] = true;
    } else {
        options['cache'] = false;
    }

    $.ajax(options);
};

// AJAX error handler
function ajaxErrorHandler(jqXHR, exception) {
    if (jqXHR.status === 0) {
        //msgAlert('Not connected.\n Verify Network.', 'error');
        return;
    } else if (jqXHR.status === 404) {
        msgAlert('Requested page not found. [404]', 'error');
    } else if (jqXHR.status === 500) {
        msgAlert('Internal Server Error [500].', 'error');
    } else if (exception === 'parsererror') {
        msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
    } else if (exception === 'timeout') {
        msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
    } else if (exception === 'abort') {
        msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
    } else {
        msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
    }
}

// home page widget
var getWidgetContent = function (e, id, name) {

    console.log('getWidgetContent - dead end');

    return;

    var params = {
        'id': id,
        'name': name
    };
    $.ajax({
        url: 'http://localhost:50490/homepage/details?version=121',
        cache: false,
        type: 'get',
        data: params,
        dataType: 'json',
        async: true,
        beforeSend: function () {
            $('.tab-content').addClass('loading-widgets');
        },
        success: function (data) {
            // append data
            data = "this is the data";
            data =
                '<div id="tab10"><header><div class="text-holder "><p><strong><span>Parsha Shiurim' +
                Math.random() +
                '</span></strong></p><ul class="tab-links"><li><a href="/categories/parsha/shemot/">See all</a></li></ul><div class="cols"><div class="col featured-left"><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/meir_goldvicht.jpg" alt="Rabbi Meir Goldwicht" width="50" height="50"></div><a href="#" class="btn-new" onclick="return!1">NEW</a></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=1020575" data-href="/sidebar/lecturedata?shiurID=1020575" data-type="video" data-id="1020575">שמות: מהותו של שם</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-meir-goldwicht/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80073"><span class="speaker-name" itemprop="name">Rabbi Meir Goldwicht</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-12-21T00:00" datetime="2021-12-21">Today</time></li><li class="posted-li"><span itemprop="location" itemscope itemtype="http://schema.org/Place"><meta itemprop="name" content="TBD"><meta itemprop="address" content="TBD"></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li></ul></div><div class="slide-box"><ul class="add"><li class="queue"><a href="#" data-id="1020575" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=1020575" data-href="/sidebar/lecturedata?shiurID=1020575" data-type="video" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/meir_goldvicht.jpg" alt="Rabbi Meir Goldwicht" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=1020423" data-href="/sidebar/lecturedata?shiurID=1020423" data-type="audio" data-id="1020423">A Persons Name is Their Essence</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-meir-goldwicht/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80073"><span class="speaker-name" itemprop="name">Rabbi Meir Goldwicht</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-12-18T00:00" datetime="2021-12-18">Dec 18, 2021</time></li><li class="posted-li"><span>Series:&nbsp;</span><a class="postedin" href="/series/kollel-yom-rishon/" data-href="@(GlobalHelper.GetSiteURL())/series/sidebar/4025">Kollel Yom Rishon</a>&nbsp;<br><span itemprop="location" itemscope itemtype="http://schema.org/Place"><meta itemprop="name" content="TBD"><meta itemprop="address" content="TBD"></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">39 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/1053/1020423.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="1020423" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=1020423" data-href="/sidebar/lecturedata?shiurID=1020423" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/dnstein.jpg" alt="Rabbi Daniel Stein" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=990216" data-href="/sidebar/lecturedata?shiurID=990216" data-type="audio" data-id="990216">A Year After Covid: Knowing When to Distance and to Lock Down</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-daniel-stein/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80415"><span class="speaker-name" itemprop="name">Rabbi Daniel Stein</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-02-17T00:00" datetime="2021-02-17">Feb 17, 2021</time></li><li class="posted-li"><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/yu-wilf-campus/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/439"><span class="address" itemprop="address name">YU Wilf Campus</span></a>&nbsp;<meta itemprop="name" content="YU Wilf Campus"><br></span><div><div class="category-group-name">Machshava:</div><div class="posted-indent"><span><a class="postedin" href="@(GlobalHelper.GetSiteURL())/machshava/jewish-thought/sichat-mussar/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234152">Sichat Mussar</a>&nbsp;</span></div></div><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/ki-tisa/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/233989">Ki Tisa</a>,&nbsp;</span><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>,&nbsp;</span><span><a class="postedin" href="/categories/parsha/teruma/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234004">Teruma</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">25 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/47660/990216.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="990216" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=990216" data-href="/sidebar/lecturedata?shiurID=990216" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/elchanan_adler.jpg" alt="Rabbi Elchanan Adler" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=985349" data-type="audio" data-id="985349">The Middah of Pharaoh</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-elchanan-adler/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80002"><span class="speaker-name" itemprop="name">Rabbi Elchanan Adler</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-17T00:00" datetime="2021-01-17">Jan 17, 2021</time></li><li class="posted-li"><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/yu-wilf-campus/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/439"><span class="address" itemprop="address name">YU Wilf Campus</span></a>&nbsp;<meta itemprop="name" content="YU Wilf Campus"><br></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/eikev/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234550">Eikev</a>,&nbsp;</span><span><a class="postedin" href="/categories/parsha/ki-tisa/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/233989">Ki Tisa</a>,&nbsp;</span><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>,&nbsp;</span><span><a class="postedin" href="/categories/parsha/va-era/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234009">Vaera</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">1 hr 13 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/47660/985349.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="985349" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=985349" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/hershel_schachter.jpg" alt="Rabbi Hershel Schachter" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=988711" data-href="/sidebar/lecturedata?shiurID=988711" data-type="audio" data-id="988711">Shemot 5781</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-hershel-schachter/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80153"><span class="speaker-name" itemprop="name">Rabbi Hershel Schachter</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-08T00:00" datetime="2021-01-08">Jan 8, 2021</time></li><li class="posted-li"><span>Series:&nbsp;</span><a class="postedin" href="/series/daily-shiur/" data-href="@(GlobalHelper.GetSiteURL())/series/sidebar/4000">Daily Shiur</a>&nbsp;<br><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/zoom-videoconference/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/845"><span class="address" itemprop="address name">Zoom Videoconference</span></a>&nbsp;<meta itemprop="name" content="Zoom Videoconference"><br></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">1 hr 17 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/55086/988711.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="988711" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=988711" data-href="/sidebar/lecturedata?shiurID=988711" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div></div><div class="col featured-right"><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/yaacov_b._neuberger.jpg" alt="Rabbi Yaakov B. Neuburger" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=987056" data-href="/sidebar/lecturedata?shiurID=987056" data-type="audio" data-id="987056">Josh Gelernter Mikraos Gedolos Parsha Chabura on Shmos - 1-7-2021</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-yaakov-b-neuburger/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80124"><span class="speaker-name" itemprop="name">Rabbi Yaakov B. Neuburger</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-07T00:00" datetime="2021-01-07">Jan 7, 2021</time></li><li class="posted-li"><span>Series:&nbsp;</span><a class="postedin" href="/series/bcbm/" data-href="@(GlobalHelper.GetSiteURL())/series/sidebar/4024">BCBM</a>&nbsp;<br><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/cong-beth-abraham-bergenfield-nj-/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/417"><span class="address" itemprop="address name">Cong. Beth Abraham (Bergenfield, NJ)</span></a>&nbsp;<meta itemprop="name" content="Cong. Beth Abraham (Bergenfield, NJ)"><br></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">31 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/926/987056.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="987056" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=987056" data-href="/sidebar/lecturedata?shiurID=987056" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/baruch_simon.jpg" alt="Rabbi Baruch Simon" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=984268" data-href="/sidebar/lecturedata?shiurID=984268" data-type="audio" data-id="984268">Yeshivat Bein Hasemesterim(Rabbi Simon Shiur):Vatirena Hameyaldot Et Haelokim: Maalat Genut Hagaava</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-baruch-simon/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80179"><span class="speaker-name" itemprop="name">Rabbi Baruch Simon</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-07T00:00" datetime="2021-01-07">Jan 7, 2021</time></li><li class="posted-li"><span>Series:&nbsp;</span><a class="postedin" href="/series/daily-shiur/" data-href="@(GlobalHelper.GetSiteURL())/series/sidebar/4000">Daily Shiur</a>&nbsp;<br><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/yu-wilf-campus/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/439"><span class="address" itemprop="address name">YU Wilf Campus</span></a>&nbsp;<meta itemprop="name" content="YU Wilf Campus"><br></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">36 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/78383/984268.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="984268" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=984268" data-href="/sidebar/lecturedata?shiurID=984268" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/dovid_miller.jpg" alt="Rabbi Dovid Miller" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=984243" data-href="/sidebar/lecturedata?shiurID=984243" data-type="audio" data-id="984243">והסנה איננו אוכל: Defying the Laws of Thermodynamics</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-dovid-miller/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80121"><span class="speaker-name" itemprop="name">Rabbi Dovid Miller</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-07T00:00" datetime="2021-01-07">Jan 7, 2021</time></li><li class="posted-li"><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/yu-wilf-campus/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/439"><span class="address" itemprop="address name">YU Wilf Campus</span></a>&nbsp;<meta itemprop="name" content="YU Wilf Campus"><br></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">45 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/47660/984243.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="984243" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=984243" data-href="/sidebar/lecturedata?shiurID=984243" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/assaf_bednarsh.jpg" alt="Rabbi Assaf Bednarsh" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=984225" data-href="/sidebar/lecturedata?shiurID=984225" data-type="audio" data-id="984225">Parsha Bytes Parshas Shemos: The Road to Heresy is Paved With Ingratitude</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-assaf-bednarsh/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80256"><span class="speaker-name" itemprop="name">Rabbi Assaf Bednarsh</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-07T00:00" datetime="2021-01-07">Jan 7, 2021</time></li><li class="posted-li"><span itemprop="location" itemscope itemtype="http://schema.org/Place"><meta itemprop="name" content="TBD"><meta itemprop="address" content="TBD"></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">5 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/32627/984225.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="984225" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=984225" data-href="/sidebar/lecturedata?shiurID=984225" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div><div class="post" itemscope itemtype="http://schema.org/Event"><div class="alignleft"><div class="img-holder"><img itemprop="image" src="https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/baruch_simon.jpg" alt="Rabbi Baruch Simon" width="50" height="50"></div></div><div class="textbox"><strong itemprop="name" class="title"><a class="shiur" href="/lectures/details?shiurID=984206" data-href="/sidebar/lecturedata?shiurID=984206" data-type="audio" data-id="984206">Shemos 5781: The Mesiras Nefesh of the Miyaldos</a></strong><ul><li class="speaker-li"><span class="speaker-icon">Speaker:</span><span itemprop="performer" itemscope itemtype="http://schema.org/Person"><a itemprop="url" class="teacher" href="/teachers/rabbi-baruch-simon/" data-href="@(GlobalHelper.GetSiteURL())/teachers/sidebar/80179"><span class="speaker-name" itemprop="name">Rabbi Baruch Simon</span></a>&nbsp;</span></li><li class="date-li"><span>Date:</span><time itemprop="startDate" content="2021-01-07T00:00" datetime="2021-01-07">Jan 7, 2021</time></li><li class="posted-li"><span itemprop="location" itemscope itemtype="http://schema.org/Place"><span>Venue:&nbsp;</span><a class="postedin" href="/venues/yu-wilf-campus/" data-href="@(GlobalHelper.GetSiteURL())/sidebar/cache/location/439"><span class="address" itemprop="address name">YU Wilf Campus</span></a>&nbsp;<meta itemprop="name" content="YU Wilf Campus"><br></span><div><div class="category-group-name">Parsha:</div><div class="posted-indent"><span><a class="postedin" href="/categories/parsha/shemot/" data-href="@(GlobalHelper.GetSiteURL())/categories/sidebar/234000">Shemot</a>&nbsp;</span></div></div></li><li class="duration-li"><span>Duration:</span><small itemprop="duration">23 min</small></li></ul></div><div class="slide-box"><ul class="add"><li class="download"><a href="https://download.yutorah.org/2021/48161/984206.mp3" title="Download this shiur" download target="_blank">Download</a></li><li class="queue"><a href="#" data-id="984206" title="Add to queue list">Play Later</a></li><li class="play"><a class="shiur" href="/lectures/details?shiurID=984206" data-href="/sidebar/lecturedata?shiurID=984206" data-type="audio" title="Play this shiur">Play Now</a></li></ul></div><div class="clear"></div></div></div></div>';

            //console.log(data);
            $(data).appendTo($('.tab-content .holder')).hide().slideDown('slow').show();
            // remove loading icon
            $('.tab-content').removeClass('loading-widgets');
            // unbind ajax call
            $(e.target).unbind('click', callWidgetLoader);
            // tabs plugin
            $('#home-tabs-area .slideset').contentTabs({
                tabLinks: 'a'
            });
            // attach events to new .post elements
            if (name == 'featured-series') {
                initAjaxAsideSidebar('#home-tabs-area #' + id + ' .textbox .title a');
            } else {
                if (name != 'trending-keywords') {
                    initFeaturedButtons('#home-tabs-area #' + id + ' .post');
                    editShiur('#home-tabs-area #' + id + ' .post');
                }
            }
        },
        error: function (jqXHR, exception) {
            ajaxErrorHandler(jqXHR, exception);
        }
    });
};

//call loader for widget data
function callWidgetLoader(e) {
    console.log('callWidgetLoader');
    var id = e.target.attributes["data-id"]["value"];
    console.log(id);
    var name = e.target.attributes["data-name"]["value"];
    console.log(name);
    getWidgetContent(e, id, name);
}

//load widget data
function loadWidgetContent() {
    console.log('loadWidgetContent');
    if ($('#home-tabs-area').length > 0) {
        var items = $('#home-tabs-area .slideset .slide');
        items.each(function () {
            var item = $(this).find('a');
            var id = item.attr('data-id');
            if (id != 'tab5') {
                item.on('click', callWidgetLoader);
            }
        });
    }
}

//fixed position for sponsorship banner
function initFixedBanner() {
    var scroller = $('#wrap-holder');
    var scrollerSmall = $(window);
    var container = $('.main-holder').width();

    if ($('#main .promo-text').length > 0) {
        var promoBox = $('#main .promo-text').html();
        var promoText = $('#main .promo-text').hide();
        var promoDesktop = $('<div class="promo-text promo-desktop">' + promoBox + '</div>'),
            promo1023 = $('<div class="promo-text promo-desktop1023">' + promoBox + '</div>'),
            promoTablet = $('<div class="promo-text-holder"><div class="promo-text">' + promoBox + '</div></div>');

        // handle window resize and scroll
        ResponsiveHelper.addRange({
            '..767': {
                on: function () {
                    promoText.show();
                    resizeFixedBannerText(promoText, 'mobile');
                }
            },
            '768..1023': {
                on: function () {
                    promoTablet.fadeIn('slow', function () {
                        $(this).show();
                    }).prependTo($('.body-box'));

                    scrollerSmall.on('scroll', function () {
                        if ($('#footer').visible(true)) {
                            promoTablet.hide();
                            promoText.show();
                        }
                        else {
                            promoText.hide();
                            promoTablet.show();
                        }
                    });
                    resizeFixedBannerText(promoTablet, 'tablet');
                },
                off: function () {
                    promoTablet.remove();
                }
            },
            '1024..1366': {
                on: function () {
                    promo1023.fadeIn('slow', function () {
                        $(this).show();
                    }).appendTo($('.container'));

                    scroller.on('scroll', function () {
                        if ($('#footer').visible(true)) {
                            promo1023.hide();
                            promoText.show();
                        }
                        else {
                            promoText.hide();
                            promo1023.show();
                        }
                    });
                    resizeFixedBannerText(promo1023, 'desktop');
                },
                off: function () {
                    promo1023.remove();
                }
            },
            '1367..': {
                on: function () {
                    promoDesktop.fadeIn('slow', function () {
                        $(this).show();
                    }).appendTo($('.container'))
                        .css({ 'margin-right': (windowWidth - container) / 2 });

                    scroller.on('scroll', function () {
                        var container = $('.main-holder').width();
                        var win = $(window).width();
                        if ($('#footer').visible(true)) {
                            promoDesktop.hide();
                            promoText.show();
                        }
                        else {
                            promoDesktop.show().css({ 'margin-right': (win - container) / 2 });
                            promoText.hide();
                        }
                    });
                    resizeFixedBannerText(promoDesktop, 'desktop');
                },
                off: function () {
                    promoDesktop.remove();
                }
            }
        });

        $(window).on('resize', function () {
            var winWidth = $(this).width();
            var container = $('.main-holder').width();
            promoDesktop.css({ 'margin-right': (winWidth - container) / 2 });
        });
    }
}

//refresh sponsorship banner view
function refreshFixedBanner() {
    ResponsiveHelper.addRange({
        '1024..1366': {
            on: function () {
                setTimeout(function () {
                    if ($('#footer').visible(true)) {
                    } else {
                        $('#main .promo-text').fadeOut('fast');
                        $('.promo-desktop1023').fadeIn('fast', function () {
                            $(this).show();
                        });
                    }
                }, 100);
            },
            off: function () {
            }
        },
        '1367..': {
            on: function () {
                setTimeout(function () {
                    if ($('#footer').visible(true)) {
                    } else {
                        $('#main .promo-text').fadeOut('fast');
                        $('.promo-desktop').fadeIn('fast', function () {
                            $(this).show();
                        });
                    }
                }, 100);
            },
            off: function () {
            }
        }
    });
}

//resize text for sponsorship banner
function resizeFixedBannerText(promoHolder, device) {
    var promoTextHeight = promoHolder.find('p').height();
    if (device == 'tablet') {
        if (promoTextHeight > 60) {
            $('.promo-text p').css('font-size', '12px');
        }
        if (promoTextHeight > 70) {
            $('.promo-text p').css('font-size', '11px');
        }
        if (promoTextHeight > 80) {
            $('.promo-text p').css('font-size', '10px');
        }
        if (promoTextHeight > 90) {
            $('.promo-text p').css('font-size', '9px');
        }
    } else {
        if (promoTextHeight > 140) {
            $('.promo-text p').css('font-size', '12px');
        }
        if (promoTextHeight > 160) {
            $('.promo-text p').css('font-size', '11px');
        }
        if (promoTextHeight > 180) {
            $('.promo-text p').css('font-size', '10px');
        }
        if (promoTextHeight > 200) {
            $('.promo-text p').css('font-size', '9px');
        }
    }
}

//footer map
var loadMapAPI = once(function () {
    window.gmap_async = $.getScript("https://maps.googleapis.com/maps/api/js?v=3.exp&sensor=false&callback=appendMap");
});

function appendMap() {
    var center = new google.maps.LatLng(36.054262, -36.367188);
    var mapOptions = {
        zoom: 2,
        center: center,
        disableDefaultUI: true
    };

    var mapHolder = $('#map-frame-holder').get(0); //check calendar styling this is causing some lines in chrome

    if (!mapHolder) { // TD: Mapholder div commented in cfm code - _footer.cfm. Discuss and remove map references if not required.
        return;
    }

    var map = new google.maps.Map(mapHolder, mapOptions); // mapHolder undefined throws exception due to missing map div.

    var markers = [
        ['Manhattan', 40.8495688, -73.929397],
        ['Jerusalem', 31.763333000000003, 35.1918898]
    ];

    //marker icons
    var imageA = _cdnPublicURL + 'images/pinA.png',
        imageB = _cdnPublicURL + 'images/pinB.png',
        contentA = '<p style="color:#000; min-width:300px;">500 West 185th Street, New York, NY 10033<br>(212) 960-5400</p>',
        contentB = '<p style="color:#000; min-width:300px;">Yeshiva University In Israel <br>40 Duvdevani Street<br>Bayit Vegan, Jerusalem 96428<br> Phone: 02.531.3000</p>';

    var positionManhattan = new google.maps.LatLng(40.8495688, -73.929397);
    var manhattan = new google.maps.Marker({
        position: positionManhattan,
        title: markers[0][0],
        icon: imageB
    });
    manhattan.setMap(map);

    var positionJerusalem = new google.maps.LatLng(31.763333000000003, 35.1918898);
    var jerusalem = new google.maps.Marker({
        position: positionJerusalem,
        title: markers[1][0],
        icon: imageA
    });
    jerusalem.setMap(map);

    infowindow = new google.maps.InfoWindow();

    //click on link above the map
    var links = $('#map-links a');
    links.each(function () {
        var item = $(this);
        item.on('click', function () {
            if (item.html() === 'Manhattan') {
                infowindow.setContent(contentA);
                infowindow.open(map, manhattan);
                map.setCenter(manhattan.getPosition()); //center marker
                map.setZoom(0);
                map.setZoom(map.getZoom() + 12);
                $('#map-frame-holder').css('height', '200px');
            }
            if (item.html() === 'Jerusalem') {
                infowindow.setContent(contentB);
                infowindow.open(map, jerusalem);
                map.setCenter(jerusalem.getPosition()); //center marker
                map.setZoom(0);
                map.setZoom(map.getZoom() + 12);
                $('#map-frame-holder').css('height', '200px');
            }
            $('#wrap-holder').scrollTo($('#footer .info'), { offsetTop: '0' });
            return false;
        });
    });

    //click on markers
    google.maps.event.addListener(manhattan, 'click', function () {
        infowindow.setContent(contentA);
        infowindow.open(map, manhattan);
        map.setCenter(manhattan.getPosition()); //center marker
        map.setZoom(0);
        map.setZoom(map.getZoom() + 12);
        $('#map-frame-holder').css('height', '200px');
        $('#wrap-holder').scrollTo($('#footer .info'), { offsetTop: '0' });
        return false;
    });

    google.maps.event.addListener(jerusalem, 'click', function () {
        infowindow.setContent(contentB);
        infowindow.open(map, jerusalem);
        map.setCenter(jerusalem.getPosition()); //center marker
        map.setZoom(0);
        map.setZoom(map.getZoom() + 12);
        $('#map-frame-holder').css('height', '200px');
        $('#wrap-holder').scrollTo($('#footer .info'), { offsetTop: '0' });
        return false;
    });
}

function initMap() {
    var scroller = $('#wrap-holder');
    if (windowWidth >= 1024 && isMobile() == false) {
        if ($('#footer').visible(true)) {
            loadMapAPI();
        } else {
            scroller.on('scroll', function () {
                if ($('#footer').visible(true)) {
                    loadMapAPI();
                }
            });
        }
    }
}

/////////////////////////////////////////////////
// Play/Add to Queue/Download buttons section //
///////////////////////////////////////////////
function featuredButtonsAttachEvents(item) {
    if (!item.hasClass('has-event')) {
        item.addClass('has-event');
        initAjaxAsideSidebarShiur(item.find('.add .play'));
        initAjaxAsideSidebarShiur(item.find('.textbox .title'));
        initAjaxAsideSidebar(item.find('.teacher'));
        initAjaxAsideSidebar(item.find('.postedin'));
        addTooltip(item.find('ul.add li a'), 'info', 'center', 'right', 'center', 'left');
    }
}

function mobileShowPostDetails(item) {
    item.find('.textbox ul li.posted-li').slideDown();
    item.find('.textbox ul li.duration-li').slideDown();
    item.find('.textbox ul li.viewed-li').slideDown();
    item.find('.textbox ul li.uploaded-li').slideDown();
    setTimeout(function () { item.find('.add').show(); }, 200);
}

function mobileHidePostDetails(item) {
    item.find('.textbox ul li.posted-li').slideUp();
    item.find('.textbox ul li.duration-li').slideUp();
    item.find('.textbox ul li.viewed-li').slideUp();
    item.find('.textbox ul li.uploaded-li').slideUp();
    item.find('.add').hide();
}

function initFeaturedButtons(el) {
    if ($(el).length > 0) {
        $(el).each(function () {
            var item = $(this);
            item.on('mouseenter click', function () {
                item.find('.add').addClass('active');
                item.addClass('active');
                if (windowWidth > 767) {
                    featuredButtonsAttachEvents(item);
                } else {
                    if (item.hasClass('post')) {
                        mobileShowPostDetails(item);
                    }
                }
            });
            item.on('mouseleave', function () {
                item.find('.add').removeClass('active');
                item.removeClass('active');
                if (windowWidth <= 767) {
                    if (item.hasClass('post')) {
                        mobileHidePostDetails(item);
                    }
                }
            });
            if (item.is(':hover')) {
                featuredButtonsAttachEvents(item);
            }

            var linkQueue = item.find('ul.add li.queue a');
            var linkDownload = item.find('ul.add li.download a');
            var dataHref = item.find('.title').find('a').attr('data-href');
            var shiurID = item.find('.title').find('a').attr('data-id');
            var dataType = item.find('.title').find('a').attr('data-type');
            linkQueue.on('click', function () {
                if (dataType == 'audio' || dataType == 'video' || dataType == 'MP3') {
                    if (($.inArray(parseInt(shiurID), queueList)) <= -1) {
                        refreshQueue('add', shiurID, 'queue', 0, '');
                        callQueue = false;
                    } else {
                        msgAlert('Shiur has already been added to your queue list.', 'good')
                    }
                } else if (dataType == 'text') {
                    if (($.inArray(parseInt(shiurID), articlesList)) <= -1) {
                        refreshQueue('add', shiurID, 'articles', 0, '');
                        callArticles = false;
                    } else {
                        msgAlert('Shiur has already been added to your articles list.', 'good')
                    }
                }
                if (windowWidth <= 767) {
                    $('body').animate({ scrollTop: 0 }, 200);
                }
                return false;
            });
            if (userAuthenticated == 1) {
                linkDownload.on('click', function (e) {
                    if (linkDownload.attr('href') != '#') {
                        urchin_logDownload(shiurID, '', '0');
                    }
                });
            } else {
                linkDownload.off().attr({ 'href': '#', 'title': 'Download. Login to use this feature' }).parent().addClass('disable');
                showLoginPanel(linkDownload);
            }
        });
    }
}
//////////////////////////////////////////////

//hide sidebar on click anywhere
function initHideAside() {
    $('#page').on('click', function (e) {
        if (!$(e.target).is('a')) {
            showHideSidebar();
        }
    });

    //on back/forward/leave click save currentTime in cookie
    $(window).bind('beforeunload', function (e) {
        //if we have active shiur playing from sidebar or cookie
        if (sessionStorage.getItem('playingShiurID') !== null /*&& (isMobile() == false)*/) {
            if (currentPlayingShiur === true) {
                //first remove old cookie value and write new
                sessionStorage.removeItem('currentTime');
                sessionStorage.setItem('currentTime', playerGetCurrentTime());
            } else {
                sessionStorage.removeItem('playingShiurID');
                sessionStorage.removeItem('currentTime');
            }
        }
        //call the interface for isPlayed
        if ((isPlayed == 1)/* && (($.inArray(playingShiurID, userJSON.myPlayedList)) == -1)*/) {
            return sendIsPlayedData('add', e);
        }
    });
}

function showHideSidebar() {
    // Check if body has class = sidebar active
    var body = $('body');
    if (body.hasClass('aside-active no-margin-body')) {
        var detailBox = $('.detail-box');
        if (detailBox.hasClass('sidebar-shiur') === false) {
            detailBox.slideToggle(function () {
                $(this).hide();
            });
            body.removeClass('aside-active no-margin-body');
        } else if (currentPlayingShiur === true) {
            // If not paused hide sidebar and show button for easy open and save html
            detailBox.slideToggle(function () {
                $(this).hide();
            });
            body.removeClass('aside-active no-margin-body');
        } else if (currentPlayingShiur === false) {
            currentPlayingShiur = true;
            $('#easy-open').remove();
            detailBox.slideToggle(function () {
                $(this).hide();
            });
            body.removeClass('aside-active no-margin-body');
        }
    }
};

// Add classes on hover/touch
function initCustomHover() {
    //var body = $('body');
    //var activeClass = 'item-active';
    //var item = $('.login-area > li:first');
    var item = $('.login-area li a.login-link');
    //var drop = item.parent().find('.login-drop');

    // new style of showing login box
    item.magnificPopup({
        items: {
            src: '.login-drop',
            type: 'inline'
        },
        //closeOnBgClick: false,
        fixedContentPos: true,
        overflowY: 'scroll',
        mainClass: 'login-popup',
        alignTop: false
    });

    // old style of showing login box
    /*item.on('click touchstart', function(e){
      if(drop.length > 0) {
        body.addClass(activeClass);
        $('input[name="loginEmail"]').focus();
        hideFromViewport('.login-area > li .login-drop', 1, 'hover');
      }
      item.parent().addClass('hover');
      e.preventDefault();
    });*/

    /*$('.login-area > li').each(function(){
      var item = $(this);
      var drop = item.find('.login-drop');
      //var registerDrop = item.find('.register-drop');
      item.touchHover({
        onHover: function(){
          if(drop.length) {
            body.addClass(activeClass)
            $('input[name="loginEmail"]').focus();
          }
          //if(registerDrop.length) {
            //body.addClass(activeClass);
            //$('input[name="firstLastName"]').focus();
          //}
        },
        onLeave: function(){
          if(drop.length) {
            body.removeClass(activeClass);
            // Focus on top search bar 
            $('#templateSearchBox').focus();
          }
          //if(registerDrop.length) {
            //body.removeClass(activeClass);
            // Focus on top search bar 
            //$('#templateSearchBox').focus();
          }
        }
      });
    });*/

    if ($('#loginForgotLink').length > 0) {
        $('#loginForgotLink').bind('click', function () {
            if ($('#loginContainer').hasClass('hide-element')) {
                $('#forgotYourPasswordContainer').addClass('hide-element');
                $('#loginContainer').removeClass('hide-element');
                $('#loginSubmit').html('<span>Log In</span>');
                $('#forgotYourPassword').val('0');
                $(this).html('Forgot your password?');

            } else if ($('#forgotYourPasswordContainer').hasClass('hide-element')) {
                $('#loginContainer').addClass('hide-element');
                $('#forgotYourPasswordContainer').removeClass('hide-element');
                $('#loginSubmit').html('<span>Reset Password</span>');
                $('#forgotYourPassword').val('1');
                $(this).html('Log in');
            }
            loginFormValidator.resetForm();
            loginFormValidator.reset();
            loginFormValidator.submitted = {};
            loginFormValidator.prepareForm();
            loginFormValidator.hideErrors();

            $('#userLoginForm').find('input.error').removeClass('error');
            $('#userLoginForm').removeData('validator');
            $('#userLoginForm').unbind('submit');
            $('#userLoginForm').data('validator', null);
            $("#userLoginForm").unbind('validate');

            var errorTag = $('#userLoginForm p.error-msg');
            if (!$(errorTag).hasClass('hide-element')) {
                $(errorTag).addClass('hide-element');
            }
            $(errorTag).html('');

            initLoginValidator();
            return false;
        });
    }

    if ($('#loginUserEmail').length > 0) {
        $('#loginUserEmail').attr('autocomplete', 'off');
    }
}

// Show more options for logging in
function initLoginDropOpener() {
    $('.box-holder-opener .less').hide();
    $('.box-holder-opener .more').on('click touchstart', function () {
        $('.login-drop').css({ 'width': '853px', 'margin-left': '-439px' });
        $('.login-drop .left-col').css({ 'width': '35.4%' });
        $('.login-drop .box-holder .box-col').css({ 'width': '50%' });
        $('.box-holder-hide').fadeIn('slow', function () {
            $(this).show();
        });
        $(this).hide();
        //$('.box-holder-opener .less').show();
        return false;
    });
    $('.box-holder-opener .less').on('click touchstart', function () {
        $('.login-drop').css({ 'width': '640px', 'margin-left': '-333px' });
        $('.login-drop .left-col').css({ 'width': '49%' });
        $('.login-drop .box-holder .box-col').css({ 'width': '94%' });
        $('.box-holder-hide').hide();
        $(this).hide();
        $('.box-holder-opener .more').show();
        return false;
    });
}

// User login validator
var initLoginValidator = function () {
    if ($('#userLoginForm').length > 0) {
        isForgotYourPassword = false;
        if ($('#forgotYourPassword').val() == '1') {
            isForgotYourPassword = true;
        }

        var rules = {};
        if (!isForgotYourPassword) {
            rules = {
                'loginUsername': {
                    'required': true
                },
                'loginPassword': {
                    'required': true
                }
            };

        } else if (isForgotYourPassword) {
            rules = {
                'loginUserEmail': {
                    'required': true,
                    'email': true
                }
            };
        }

        var options = {
            'errorClass': 'error',
            'rules': rules,
            errorPlacement: function (error, element) {
                $(element).before(error);
            },
            submitHandler: function (form) {
                var isSubmitted = false;

                if (!isSubmitted) {
                    isSubmitted = true;

                    var errorTag = $('#userLoginForm p.error-msg');
                    if (!$(errorTag).hasClass('hide-element')) {
                        $(errorTag).addClass('hide-element');
                    }

                    var formElements = $(form).serialize();
                    $.ajax({
                        url: form.action,
                        type: form.method,
                        data: formElements,
                        dataType: 'json',
                        success: function (response) {
                            // Process failed
                            if (response['errorMessage'] != '') {
                                $(errorTag).html(response['errorMessage']);
                                $(errorTag).removeClass('hide-element');

                                // Resend activation email 
                                if ($(errorTag).find('#resendActivationEmail').length > 0) {
                                    var params = {};
                                    if (typeof response['userEmail'] != 'undefined') {
                                        params = response;
                                    } else {
                                        $(errorTag).find('#resendActivationEmail').hide();
                                    }

                                    var isSubmittedResendActivationEmail = false;
                                    $(errorTag).find('#resendActivationEmail').on('click', function () {
                                        if (!isSubmittedResendActivationEmail) {
                                            isSubmittedResendActivationEmail = true;

                                            $.ajax({
                                                url: _siteURL + '/login_resend_activation_email.cfm',
                                                type: 'post',
                                                data: params,
                                                dataType: 'json',
                                                success: function (response2) {
                                                    isSubmittedResendActivationEmail = false;

                                                    var errorTag = $('#userLoginForm p.error-msg');
                                                    if (response2['errorMessage'] != '') {
                                                        $(errorTag).html(response2['errorMessage']);
                                                        $(errorTag).removeClass('hide-element');
                                                    }
                                                }
                                            }).done(
                                                function () {
                                                    isSubmittedResendActivationEmail = false;
                                                    if (typeof console != 'undefined') {
                                                        //console.log('success', arguments);
                                                    }
                                                }).fail(function () {
                                                    if (typeof console != 'undefined') {
                                                        //console.log('failure', arguments);
                                                    }
                                                });
                                        }
                                        return false;
                                    });
                                }

                                if (!isForgotYourPassword) {
                                    $('#loginUsername').val('');
                                    $('#loginPassword').val('');
                                } else if (isForgotYourPassword) {
                                    $('#loginUserEmail').val('');
                                }

                                // Process successful
                            } else if (response['pageFrom'] != '') {
                                $(errorTag).addClass('hide-element');
                                $(location).attr('href', response['pageFrom']);
                            }
                            else if (response['pageFrom'] == '' && response["errorMessage"] == '') {
                                location.reload();
                            }

                            isSubmitted = false;
                        }
                    }).done(
                        function () {
                            isSubmitted = false;
                            if (typeof console != 'undefined') {
                                //console.log('success', arguments);
                            }
                        }).fail(function () {
                            if (typeof console != 'undefined') {
                                //console.log('failure', arguments);
                            }
                        });
                }
            }
        };
        loginFormValidator = $("#userLoginForm").validate(options);
    }
};

// Subscribe validator
var initSubscribeValidator = function () {
    if ($('#subscribeForm').length > 0) {
        var rules = {
            'subscribeEmailAddress': {
                'required': true,
                'email': true
            }
        };
        var options = {
            'errorClass': 'error',
            'rules': rules,
            errorPlacement: function (error, element) {
                $(element).parent().parent().before(error);
            },
            submitHandler: function (form) {
                var isSubmitted = false;

                if (!isSubmitted) {
                    isSubmitted = true;

                    $.ajax({
                        url: form.action,
                        type: form.method,
                        data: $(form).serialize(),
                        dataType: 'html',
                        success: function (response) {
                            $('#subscribeFormContainer').html(response);
                            isSubmitted = false;
                        }
                    }).done(
                        function () {
                            isSubmitted = false;
                            if (typeof console != 'undefined') {
                                //console.log('success', arguments);
                            }
                        }).fail(function () {
                            if (typeof console != 'undefined') {
                                //console.log('failure', arguments);
                            }
                        });
                }
            }
        };
        $("#subscribeForm").validate(options);
    }
};

////////////////////////////////////////////////////////////////////////////////
// Create Shiur sidebar content
var loadScribdAPI = once(function (data) {
    window.scribd_async = $.getScript("https://www.scribd.com/javascripts/scribd_api.js", function () {
        sidebarShiurScribd(data);
    });
});

var initAjaxAsideSidebarShiur = function (el, playerStatus) {
    var items = $(el);
    if (items.length > 0) {
        ResponsiveHelper.addRange({
            '1024..': {
                on: function () {
                    items.each(function () {
                        var item = $(this);
                        var link = item.find('a.shiur');
                        var url = link.attr('data-href');
                        var dataPage = '';
                        var itemClass = item.attr('class');
                        dataPage = link.attr('data-page');
                        var playerTime = 0;
                        playerTime = link.attr('data-time');
                        //daf page have media type for Realted Content and Daf Yomi shiuirm section
                        //so if we have data type != text and data-page != daf then we should build sidebar
                        if (url) {
                            if (dataPage != 'daf') {
                                link.on('click', function (e) {
                                    e.preventDefault();
                                    initAjaxSidebarShiurClick(link, itemClass, playerTime, playerStatus);
                                    return false;
                                });
                            } else {
                                link.unbind();
                            }
                        } else {
                            link.unbind();
                        }
                    });
                },
                off: function () {
                    items.each(function () {
                        var item = $(this);
                        var link = item.find('a');
                        link.unbind();
                    });
                }
            }
        });
    }
}

var initAjaxSidebarShiurClick = function (link, itemClass, playerTime, playerStatus) {
    var body = $('body');
    body.removeClass('aside-active no-margin-body');

    link.qtip('destroy', true);

    initAjaxShowSidebarShiur();

    // Slavisa: TODO put email notification on error
    var url = link.attr('data-href');
    console.log('sidebar statistics', url);
    ajaxLoadContent(url, 'json', false, function (data) { // Load JSON output
        setTimeout(function () {
            if (!$.isEmptyObject(data)) {
                if (isCalled == 0) {
                    initAjaxCreateSidebarShiur(data, itemClass, playerTime, playerStatus);
                    isCalled = 1;
                }
            } else {
                msgAlert('Error loading content. Please try again.', 'error');
                $('.detail-box').fadeOut('fast');
            }
        }, 500);
    });

    isCalled = 0;
    body.addClass('aside-active no-margin-body');

};

var initAjaxShowSidebarShiur = function () {
    var win = $(window).height();
    var main = $('#wrapper');
    var page = $('html, body');
    var body = $('body');

    var isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent);
    var animSpeed = 300;

    var loadedContent = $('<div class="loaded-content"></div>').html(shiurHTML);
    var detailBox = loadedContent.find('.detail-box');
    detailBox.find('.tabs-heading').hide();
    var detailBoxInner = loadedContent.find('.detail-box-inner');
    detailBoxInner.css({ 'min-height': win + 'px', 'min-width': '437px' });
    detailBoxInner.children().remove();

    var loader = $('<div id="loading-sidebar"></div>');
    loader.prependTo(detailBox);
    //var detailBox = $('<div class="detail-box"></div>');
    detailBox.css({
        right: '-100%'
    });
    if (detailBox.length) {
        window.picturefill();
        $('.detail-box').remove();
        detailBox.appendTo(body);

        detailBox.css({
            right: ''
        });

        if (!isWinPhoneDevice) {
            page.stop().animate({
                scrollTop: detailBox.offset().top
            }, {
                duration: animSpeed,
                complete: function () {
                    if (main.height() < detailBox.height()) {
                        main.css({ height: detailBox.height() });
                        initSameHeight();
                    }
                }
            });
        }
    }
};

function sidebarShiurCollectionList(detailBox) {
    var collectionList = $(detailBox).find('.collection-list li').hide();
    $.each(collectionList, function () {
        var item = $(this);
        if (item.hasClass('current')) {
            item.show();
            var showUp = item.prevAll('li').length;
            var showDown = item.nextAll('li').length;
            if (showUp > 4) {
                item.prevAll(':lt(4)').show();
                $('.collection-previous').html('[' + (showUp - 4) + ' previous]');
            } else {
                item.prevAll(':lt(4)').show();
            }
            if (showDown > 4) {
                item.nextAll(':lt(4)').show();
                $('.collection-after').html('[' + (showDown - 4) + ' more]');
            } else {
                item.nextAll(':lt(4)').show();
            }
        }
    });
}

function sidebarShiurCollectionListButtons(detailBox) {
    $(detailBox).find('.open-collecion').on('click', function () {
        detailBox.find('.collection-list li').fadeIn('fast', function () {
            $(this).show();
        });
        $(detailBox).find('.collection-previous').hide();
        $(detailBox).find('.collection-after').hide();
        $(detailBox).find('.close-collecion').show();
        $(this).hide();
        return false;
    });

    $(detailBox).find('.close-collecion').on('click', function () {
        sidebarShiurCollectionList(detailBox);
        $(detailBox).find('.collection-previous').show();
        $(detailBox).find('.collection-after').show();
        $(detailBox).find('.open-collecion').show();
        $(this).hide();
        return false;
    });
}

function sidebarShiurScribd(data) {
    var scribd_doc = scribd.Document.getDoc(data.shiurScribdDocID, data.shiurScribdAccessKey);
    var oniPaperReady = function (e) {
        /*scribd_doc.api.setPage(3);*/
    };
    scribd_doc.addEventListener('iPaperReady', oniPaperReady);
    scribd_doc.addParam('jsapi_version', 2);
    scribd_doc.addParam('height', 500);
    scribd_doc.addParam('width', 400);
    scribd_doc.write('shiur-text-holder');
}

var initAjaxCreateSidebarShiur = function (sidebarShiurData, itemClass, playerTime, playerStatus) {
    var loadedContent = $('<div class="loaded-content"></div>').html(shiurHTML);
    var detailBox = loadedContent.find('.detail-box-holder');
    $('#loading-sidebar').remove();
    console.log("sidebar Data: ",sidebarShiurData);
    if (detailBox?.length) {
        window.picturefill();
        $('.detail-box-inner').css({ 'min-width': '420px' });
        detailBox.hide().appendTo('.detail-box-inner').fadeIn(500);
        $('.tabs-heading').show();
        detailBox.css({
            right: ''
        });
    }

    //////////////////////////////////////////////////////////////////////////
    // Browser History: Set the shiur sidebar URL as the browser address bar 
    if (!isBackForwardButton) {
        var pageTitle = sidebarShiurData.shiurTitle;
        var pageURL = sidebarShiurData.shiurHref.replace(_siteURL + '/lectures/', '/sidebar/lecturedata/');
        stateChangedManually = true;
        if (!disableHistoryStateChange) {
            History.pushState({ state: 1, rand: Math.random() }, pageTitle, pageURL);
        }
    }
    isBackForwardButton = false;
    //////////////////////////////////////////////////////////////////////////


    //create person head element
    var personHead = $('<div class="person-head">');

    personHead.appendTo('.sidebar-shiur .person-info');

    //create title element
    var shiurTitle = $('<strong data-id="' + sidebarShiurData.shiurID + '" class="title main-title" itemprop="headline" content="' + sidebarShiurData.shiurTitle + '">' + sidebarShiurData.shiurTitle + '</strong>');
    shiurTitle.appendTo(personHead);

    //create img holder element
    var shiurAlignLeft = $('<div class="alignleft">');
    shiurAlignLeft.appendTo(personHead);

    //create info holder element
    var shiurInfo = $('<div class="info">');
    var shiurInfoP = $('<p class="info-speaker">');
    shiurInfoP.appendTo(shiurInfo);
    shiurInfo.appendTo(personHead);

    //create teacher(s) img and teacher(s) name(s)
    if (sidebarShiurData.shiurTeachers?.length > 0) {
        $.each(sidebarShiurData.shiurTeachers, function (i) {
            //add only first teacher photo
            var newphoto = '<img src="' + sidebarShiurData.shiurTeachers[i].teacherPhotoURL_lp + '" alt="' + sidebarShiurData.shiurTeachers[i].teacherFullName + '">';
            $(newphoto).appendTo(shiurAlignLeft);

            var newteacher = '<a class="teacher" href="' + sidebarShiurData.shiurTeachers[i].landingPageURL + '" data-href="/teachers/sidebar/' + sidebarShiurData.shiurTeachers[i].teacherID + _svnRevision + '">' + sidebarShiurData.shiurTeachers[i].teacherFullName + '</a>';
            if (sidebarShiurData.shiurTeachers?.length != i + 1) {
                $(newteacher).appendTo(shiurInfoP).after(', ');
            } else {
                $(newteacher).appendTo(shiurInfoP);
            }
        });
    }

    imgSlideShow('.detail-box .alignleft');

    //create date element
    var shiurDate = $('<time class="date" datetime="' + sidebarShiurData.shiurDateFormatted + '"><span>' + sidebarShiurData.shiurDateText + '</span></time>');
    shiurDate.appendTo(shiurInfo);

    //create duration element + call audio player
    if (sidebarShiurData.shiurDuration !== '') {
        var shiurDuration = $('<p class="info-duration"><span>' + sidebarShiurData.shiurDuration + '</span></p>');
        shiurDuration.appendTo(shiurInfo);
    }

    detailBox.find('#jp_container').attr('data-id', sidebarShiurData.shiurID);

    if (sidebarShiurData.mediaTypeCategory == 'audio' || sidebarShiurData.mediaTypeCategory == 'video') {
        if (playerStatus == 'player-on') {
            createSidebarPlayerControls(sidebarShiurData.shiurID); // create controls for sidebar player
            detailBox.find('#jp_container').addClass('playing-shiur');
            if (sidebarShiurData.mediaTypeCategory == 'video') {
                createSidebarPlayerControls(sidebarShiurData.shiurID); // create controls for sidebar player
                createSidebarPlayerVideoContent();
                detailBox.find('#jp_container').addClass('playing-shiur');
                $('#jp-video').css('height', '200px');
                $('#jp-video img').hide();
            } else {
                detailBox.find('#jp-video').remove();
            }
        } else {
            //pause current shiur
            pauseOtherPlayers = true;

            //check if shiur can be download = can be played
            if (sidebarShiurData.shiurNeedsToBeEmbed == 0) {
                // if play button clicked
                if (itemClass == 'play') {
                    // if is the same shiur
                    if (playingShiurID == sidebarShiurData.shiurID && sessionStorage.getItem('playingShiurID') !== null) {
                        sessionStorage.setItem('currentTime', playerGetCurrentTime());
                        detailBox.find('#jp_container').addClass('playing-shiur');
                        initSidePlayer(sidebarShiurData, '', playerTime, 'play'); //call the player
                    } else {
                        sessionStorage.removeItem('playingShiurID');
                        sessionStorage.removeItem('currentTime');
                        sessionStorage.setItem('playingShiurID', sidebarShiurData.shiurID);
                        detailBox.find('#jp_container').addClass('playing-shiur');
                        initSidePlayer(sidebarShiurData, '', playerTime); //call the player
                        playerAddEffect(); //player effect on click
                    }
                } else {
                    // if is the same shiur and clicked on title
                    if (playingShiurID == sidebarShiurData.shiurID && sessionStorage.getItem('playingShiurID') !== null /*$.cookie('playingShiurID')*/) {
                        sessionStorage.setItem('currentTime', playerGetCurrentTime());
                        detailBox.find('#jp_container').addClass('playing-shiur');
                        initSidePlayer(sidebarShiurData, '', playerGetCurrentTime(), 'play'); //call the player
                    } else {
                        if (sidebarShiurData.shiurMediaLengthInSeconds != '') {
                            detailBox.find('.jp-duration').html((sidebarShiurData.shiurMediaLengthInSeconds));
                        }
                        detailBox.find('.jp-volume-bar').slider({
                            value: 90,
                            max: 100,
                            range: 'min',
                            animate: true,
                            orientation: "horizontal"
                        });
                        detailBox.find('.jp-progress').slider({
                            value: 0,
                            max: 100,
                            range: 'min',
                            animate: true,
                            step: 0.1,
                            orientation: "horizontal"
                            /*disabled: true*/
                        });
                        detailBox.find('.jp-play').on('click', function () {
                            $(this).unbind();
                            sessionStorage.removeItem('playingShiurID');
                            sessionStorage.removeItem('currentTime');
                            sessionStorage.setItem('playingShiurID', sidebarShiurData.shiurID);
                            detailBox.find('.jp-progress').slider('destroy');
                            initSidePlayer(sidebarShiurData, '', 0, 'play'); //call the player
                        });
                    }
                }
            }

            if (sidebarShiurData.shiurNeedsToBeEmbed == 0 && sidebarShiurData.mediaTypeCategory == 'audio') {
                detailBox.find('#jp-video').remove();
            } else if (sidebarShiurData.shiurNeedsToBeEmbed == 0 && sidebarShiurData.mediaTypeCategory == 'video') {
                detailBox.find('#jp-video').css('height', '200px').on('click', function () {
                    $(this).unbind();
                    sessionStorage.removeItem('playingShiurID');
                    sessionStorage.removeItem('currentTime');
                    initSidePlayer(sidebarShiurData, '', playerTime, 'play'); //call the player
                });
            } else if (sidebarShiurData.shiurNeedsToBeEmbed == 1 && sidebarShiurData.mediaTypeCategory == 'video') {
                detailBox.find('#jp_container').remove();
                detailBox.find('#jp-video .jp-full-screen-link').remove();
                $(sidebarShiurData.playerDownloadURL).appendTo(detailBox.find('#jp-video .video-container'));
            } else {
                detailBox.find('#jp_container').remove();
                detailBox.find('#jp-video').remove();
            }
        }
    } else if (sidebarShiurData.mediaTypeCategory == 'text') {
        detailBox.find('#jp_container').remove();
        detailBox.find('#jp-video').remove();
    }


    //create info icons holder element
    var shiurIcons = $('<ul class="info-icons">');
    shiurIcons.appendTo(shiurInfo);

    //create audio icon element
    if (sidebarShiurData.mediaTypeCategory && sidebarShiurData.mediaTypeCategory === 'audio') {

    } else if (sidebarShiurData.mediaTypeCategory === 'video') {
        $('<li class="media-type video"><a>Video</a></li>').appendTo(shiurIcons);
    } else {
        $('<li class="media-type text"><a>Text</a></li>').appendTo(shiurIcons);
    }

    //create level icon element
    //$('<li class="style-type hard">Level: <a href="#">Hard</a></li>').appendTo(shiurIcons);

    //create language icon element
    if (sidebarShiurData.shiurLanguage && sidebarShiurData.shiurLanguage === 'EN') {
    }
    else {
        $('<li class="lang-type"><a>Hebrew</a></li>').appendTo(shiurIcons);
    }

    //create more button
    var shiurMore = $('<ul class="shiur-links add">');
    shiurMore.appendTo(shiurInfo);
    if (sidebarShiurData.shiurCanBeDownloaded == 1 && sidebarShiurData.downloadURL != '') {
        $('<li class="download"><a href="' + sidebarShiurData.downloadURL + '" title="Download this shiur" download target="_blank">Download</a></li>').appendTo(shiurMore);
    } /*else { //hide download button
    $('<li class="download"><a href="#" title="This shiur cannot be downloaded">Download</a></li>').appendTo(shiurMore);
  }*/
    if (sidebarShiurData.mediaTypeCategory == 'text') {
        $('<li class="queue"><span class="title"><a href="#" data-type="' + sidebarShiurData.mediaTypeCategory + '" data-id="' + sidebarShiurData.shiurID + '" title="Add to article list">Add to articles</a></span></li>').appendTo(shiurMore);
        if (sidebarShiurData.shiurText != '') {
            $('<li class="print-sidebar"><a data-href="' + sidebarShiurData.shiurLecturePageURL + '" href="#">Print full page</a></li>').appendTo(shiurMore);
        }
    } else {
        $('<li class="queue"><span class="title"><a href="#" data-type="' + sidebarShiurData.mediaTypeCategory + '" data-id="' + sidebarShiurData.shiurID + '" title="Add to queue list">Add to queue</a></span></li>').appendTo(shiurMore);
    }
    $('<li class="full"><a href="' + sidebarShiurData.shiurLecturePageURL + '">Go to full page</a></li>').appendTo(shiurMore);
    $('<li class="full"><a href="' + sidebarShiurData.shiurLecturePageURL.replace("/lectures/", "/lectures/v5/") + '">Preview new shiur page</a></li>').appendTo(shiurMore);

    var facebookUrl = "#"
    var twitterUrl = "#"
    var mailUrl = "#"
    if (sidebarShiurData.shiurLecturePageURL != null && sidebarShiurData.shiurLecturePageURL != "") {
        var encodedFacebookUrl = encodeURIComponent(sidebarShiurData.shiurLecturePageURL)
        facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodedFacebookUrl}&amp;src=sdkpreparse`
        twitterUrl = `https://twitter.com/intent/tweet?text=${'YUTorah - ' + sidebarShiurData.shiurTitle}&url=${sidebarShiurData.shiurLecturePageURL}`;
        mailUrl = `mailto:?subject=${'YUTorah - ' + sidebarShiurData.shiurTitle}&body=${'YUTorah - ' + sidebarShiurData.shiurTitle}%20${sidebarShiurData.shiurLecturePageURL}`;
    }

    var shiurSocials = '';
    shiurSocials += '<div class="share-bar shiur-sidebar-share">';
    shiurSocials += '<span>Share this:</span>';
    shiurSocials += '<ul>';
    shiurSocials += '<li class="facebook"><a href="' + facebookUrl + '" class="addthis_button_facebook at300b" title="Facebook" target="_blank"><span>Facebook</span></a></li>';
    // shiurSocials += '<li class="googleplus"><a href="#" class="addthis_button_google_plusone_share at300b" target="_blank" title="Google+"><span>Google+</span></a></li>';
    shiurSocials += '<li class="twitter"><a href="' + twitterUrl + '" class="addthis_button_twitter at300b" title="Tweet" target="_blank"><span>Twitter</span></a></li>';
    shiurSocials += '<li class="mail"><a href="' + mailUrl + '"  class="addthis_button_email at300b" title="Mail"><span>Mail</span></a></li>';
    shiurSocials += '</ul>';
    shiurSocials += '</div>';

    $(shiurSocials).appendTo(shiurInfo);

    // Social links recreate and create tooltip
    loadAddThis('.shiur-sidebar-share', sidebarShiurData.shiurLecturePageURL);
    addTooltip('.shiur-sidebar-share a', 'info');

    // for text shiurs load scribd document
    if (sidebarShiurData.mediaTypeCategory == 'text') {
        if (sidebarShiurData.shiurScribdDocID) {
            if (!window.scribd) {
                loadScribdAPI(sidebarShiurData);
            } else {
                sidebarShiurScribd(sidebarShiurData);
            }
        } else {
            var ext = sidebarShiurData.downloadURL?.slice(-3).toLowerCase();
            if (ext == 'pdf') {
                detailBox.find('.shiur-text-holder').append('<iframe class="pdf-embed-file" src="' + _cdnPublicURL + 'js/pdf/web/viewer.html?file=' + "https://shiurim.yutorah.net" + sidebarShiurData.shiurURL + '" border="0"></iframe>');

            }
            else if (ext == 'doc' || ext == 'ocx') {
                detailBox.find('.shiur-text-holder').append('<iframe class="pdf-embed-file" src="https://view.officeapps.live.com/op/embed.aspx?src=' + "https://shiurim.yutorah.net" + sidebarShiurData.shiurURL + '"></iframe>');
            } else {
                if (sidebarShiurData.shiurText) {
                    if (sidebarShiurData.shiurLanguage == 'HE') {
                        detailBox.find('.shiur-text').addClass('align-right');
                    }
                    detailBox.find('.shiur-text').append($.parseHTML(sidebarShiurData.shiurText)/*.text()*/);
                    detailBox.find('.shiur-text').addClass('text');
                    if (sidebarShiurData.shiurText?.length > 200) {
                        var more = $('<a href="#" class="more-info"><span class="static">Read more</span><span class="active">Read less</span></a>');
                        more.appendTo(detailBox.find('.shiur-text-buttons'));
                        $(detailBox).find('.more-info').on('click', function () {
                            if ($(detailBox).find('.shiur-text').hasClass('active')) {
                                $(detailBox).find('.shiur-text').removeClass('active');
                                $(this).find('.active').hide();
                                $(this).find('.static').show();
                            } else {
                                $(detailBox).find('.shiur-text').addClass('active');
                                $(this).find('.static').hide();
                                $(this).find('.active').show();
                            }
                            return false;
                        });
                    }
                } else {
                    detailBox.find('.shiur-text-holder').remove();
                }
            }
        }
    } else {
        detailBox.find('.shiur-text-holder').remove();
    }

    // Description
    if (sidebarShiurData.shiurDescription) {
        detailBox.find('.about-shiur').after($('<p class="description">' + sidebarShiurData.shiurDescription + '</p>'));
    } else {
        detailBox.find('.description').remove();
    }


    // Posted in series
    getPostedInSeries(sidebarShiurData, detailBox.find('.series'), true);

    // Posted in categories
    getPostedInCategories(sidebarShiurData, detailBox.find('.categories'), true);

    // Posted in venues
    getPostedInVenues(sidebarShiurData, detailBox.find('.venues'), true);

    // Keywords
    if (sidebarShiurData.shiurKeywords?.length > 0) {
        $.each(sidebarShiurData.shiurKeywords, function (i) {
            var newkeyword = '<a href="' + this.keywordURL + '">' + this.keywordTitle + '</a>';
            if (sidebarShiurData.shiurKeywords.length != i + 1) {
                $(newkeyword).appendTo(detailBox.find('.keywords')).after(', ');
            } else {
                $(newkeyword).appendTo(detailBox.find('.keywords'));
            }

        });
    } else {
        detailBox.find('.keywords').prev().remove();
        detailBox.find('.keywords').remove();
    }

    // Additional Materials
    if (sidebarShiurData.shiurAdditionalMaterials?.length > 0) {
        $.each(sidebarShiurData.shiurAdditionalMaterials, function () {
            var newMaterial = '<li><a href="' + (this.materialURL.startsWith('http') ? this.materialURL : _cdnMaterialsUrl + this.materialURL) + '" download target="_blank">' + this.materialTitle + '</a></li>';
            $(newMaterial).appendTo(detailBox.find('.pdf'));
        });
    } else {
        detailBox.find('.pdf').prev().remove();
        detailBox.find('.pdf').remove();
    }

    // Collections
    var hasShiurCollectionData = hasNonEmptyProperties(sidebarShiurData.shiurCollection);
    if (hasShiurCollectionData) {
        var collectionItems = '';
        detailBox.find('.collection-name').html(sidebarShiurData.shiurCollection.collectionName).attr('href', sidebarShiurData.shiurCollection.collectionURL);

        if (!$.isEmptyObject(sidebarShiurData.shiurCollection.collectionShiurim)) {
            $.each(sidebarShiurData.shiurCollection.collectionShiurim, function (i) {
                if (sidebarShiurData.shiurCollection.collectionShiurim[i]) {
                    if (sidebarShiurData.shiurCollection.collectionShiurim[i].shiurID == sidebarShiurData.shiurID) {
                        collectionItems += '<li class="current"><span>No. ' + (i + 1) + ':</span> <a href="' + sidebarShiurData.shiurCollection.collectionShiurim[i].shiurHref + '">' + sidebarShiurData.shiurCollection.collectionShiurim[i].shiurTitle + '</a></li>';
                    } else {
                        collectionItems += '<li><span>No. ' + (i + 1) + ':</span> <a class="shiur" href="' + sidebarShiurData.shiurCollection.collectionShiurim[i].shiurHref + '" data-href="' + sidebarShiurData.shiurCollection.collectionShiurim[i].shiurDataHref + '" data-id="' + sidebarShiurData.shiurCollection.collectionShiurim[i].shiurID + '">' + sidebarShiurData.shiurCollection.collectionShiurim[i].shiurTitle + '</a></li>';
                    }
                }
            });
        }

        $(collectionItems).appendTo(detailBox.find('.collection-list'));

        if (sidebarShiurData.shiurCollection.collectionShiurim?.length > 9) {
            sidebarShiurCollectionList(detailBox);
            sidebarShiurCollectionListButtons(detailBox);
        } else {
            detailBox.find('.collection .open-collecion').remove();
            detailBox.find('.collection .close-collecion').remove();
            detailBox.find('.collection-previous').remove();
            detailBox.find('.collection-after').remove();
        }
    } else {
        detailBox.find('.collection').remove();
    }

    // References
    if (sidebarShiurData.shiurReferences?.length > 0) {
        $.each(sidebarShiurData.shiurReferences, function (i) {
            var newReference = '<li><a href="' + sidebarShiurData.shiurReferences[i].href + '">' + sidebarShiurData.shiurReferences[i].referenceName + '</a></li>';
            $(newReference).appendTo(detailBox.find('.references'));
        });
    } else {
        detailBox.find('.references').prev().remove();
        detailBox.find('.references').remove();
    }

    // Publication
    if (sidebarShiurData.shiurPublicationVolumeKey != null) {
        var newPublication = `<a class="" href='/publications/?publicationid=` + sidebarShiurData.shiurPublicationId + `&publicationvolumeid=` + sidebarShiurData.shiurPublicationVolumeKey + `'><span class="mark">` + sidebarShiurData.shiurPublicationName + ` ` + sidebarShiurData.shiurPublicationVolumeName + `</span></a>`;
        $(newPublication).appendTo(detailBox.find('.publication'));
    } else {
        detailBox.find('.publication').prev().remove();
        detailBox.find('.publication').remove();
    }

    // Number of visits, downloads, comments - TODO: This data needs to come from the db. Also, shiur views needs to be updated on each click
    var statUl = $('<ul>');
    $('<li class="number-visits"><strong>' + sidebarShiurData.shiurVisitsNumber + '</strong> views</li>').appendTo(statUl);
    $('<li class="number-downloads"><strong>' + sidebarShiurData.shiurDownloadsNumber + '</strong> downloads</li>').appendTo(statUl);
    $('<li class="number-comments"><strong>' + sidebarShiurData.shiurCommentsNumber + '</strong> comments</li>').appendTo(statUl);
    statUl.appendTo(detailBox.find('.info-statistic'));
    $('<div class="clear"><div>').appendTo(detailBox.find('.info-statistic'));

    // More from this speaker, category, series
    if ($.isEmptyObject(sidebarShiurData.moreFromSpeakers) && $.isEmptyObject(sidebarShiurData.moreFromSeries) && $.isEmptyObject(sidebarShiurData.moreFromCategories)) {
        detailBox.find('.tabs').remove();
    }

    // speaker
    if (sidebarShiurData.mediaTypeCategory == 'text') {
        detailBox.find('.more-speaker a').html('AUTHOR');
    }

    if (sidebarShiurData.moreFromSpeakerHTMLSnippet != '') {
        $(sidebarShiurData.moreFromSpeakerHTMLSnippet).appendTo(detailBox.find('#tab21'));
    }
    else {
        console.log('moreFrom speaker section: ', detailBox.find('.tabset li.more-speaker'), detailBox.find('.tabset js-tabset li.more-speaker'))
        detailBox.find('.tabset li.more-speaker').remove();
        detailBox.find('#tab21').remove();
        detailBox.find('.tabset li.more-series a').addClass('active');
    }

    // series
    if (sidebarShiurData.moreFromSeriesHTMLSnippet != '') {
        $(sidebarShiurData.moreFromSeriesHTMLSnippet).appendTo(detailBox.find('#tab22'));
    }
    else {
        detailBox.find('.tabset li.more-series').remove();
        detailBox.find('#tab22').remove();
        detailBox.find('.tabset li.more-categories a').addClass('active');
    }

    // categories
    if (sidebarShiurData.moreFromCategoryHTMLSnippet != '') {
        $(sidebarShiurData.moreFromCategoryHTMLSnippet).appendTo(detailBox.find('#tab23'));
    }
    else {
        detailBox.find('.tabset li.more-category').remove();
        detailBox.find('#tab23').remove();
    }

    if (sidebarShiurData.moreFromSpeakerHTMLSnippet != '' || sidebarShiurData.moreFromSeriesHTMLSnippet != '' || sidebarShiurData.moreFromCategoryHTMLSnippet != '') {
        detailBox.find('.js-tabset').contentTabs({
            tabLinks: 'a'
        });
    }

    var tabs = $('.tabs-heading ul li a');
    $.each(tabs, function () {
        var item = $(this);
        item.on('click', function () {
            $('.tabs-heading ul li a').removeClass('active');
            item.addClass('active');
        });
    });

    if (sidebarShiurData.teacherSponsor != null && sidebarShiurData.teacherSponsor.length > 0) {
        sidebarShiurData.teacherSponsor.forEach(function (sponsor) {
            $('.sponsors').append(
                $('<div>', {
                    class: 'sponsor-message',
                    text: sidebarShiurData.shiurTeachers[0].teacherFullName + "'s shiurim today have been sponsored by " +
                        sponsor.sponsorName + " " +
                        sponsor.sponsorPrefix + " " +
                        sponsor.sponsorMessage
                })
            );
        });
    } else {
        //$('.sponsors').append(
        //    $('<div>', {
        //        class: 'sponsor-message'
        //    }).append(
        //        $('<a>', {
        //            href: 'https://www.givecampus.com/campaigns/50770/donations/new',
        //            target: '_blank',
        //            text: "Click here to sponsor " + sidebarShiurData.shiurTeachers[0].teacherFullName + "'s shiurim",
        //            style: "color: white;"
        //        })
        //    )
        //);
    }

    // Feedback
    var counter = 0;
    $.each(sidebarShiurData.shiurTeachers, function () {
        if (this.teacherEmail != '') {
            var teacher;
            /*var teacher,
            label;
            if(data.mediaTypeCategory == 'text'){
              label = '<i class="fa fa-question-circle"></i> Ask author';
            } else {
              label = '<i class="fa fa-question-circle"></i> Ask speaker';
            }*/
            if (userAuthenticated == 1) {
                console.log(_siteURL, sidebarShiurData.shiurID, '<li><a title="Ask a question" href="#" onclick="tb_show(\'Ask a question\', \''
                    + _siteURL
                    + '/askQuestion.cfm?shiurID='
                    + sidebarShiurData.shiurID
                    + '&amp;teacherID='
                    + this.teacherID
                    + '&amp;KeepThis=true&amp;TB_iframe=true&amp;height=400&amp;width=480&amp;modal=true;\'); return false;" class="thickbox ask-teacher-sidebar"><i class="fa fa-question-circle"></i>Ask '
                    + this.teacherFullName
                    + ' a question</a></li>');
                //teacher = $('<li><a title="Ask a question" href="#" onclick="tb_show(\'Ask a question\', \'' + _siteURL + '/askQuestion.cfm?shiurID=' + data.shiurID + '&amp;teacherID=' + this.teacherID + '&amp;KeepThis=true&amp;TB_iframe=true&amp;height=400&amp;width=480&amp;modal=true;\'); return false;" class="thickbox ask-teacher-sidebar">' + label + '</a>' + this.teacherFullName + '</li>');
                teacher = $('<li><a title="Ask a question" href="#" onclick="tb_show(\'Ask a question\', \''
                    + _siteURL
                    + '/teachers/ask-question?shiurId='
                    + sidebarShiurData.shiurID
                    + '&amp;teacherId='
                    + this.teacherID
                    + '&amp;KeepThis=true&amp;TB_iframe=true&amp;height=400&amp;width=480&amp;modal=true;\'); return false;" class="thickbox ask-teacher-sidebar"><i class="fa fa-question-circle"></i>Ask '
                    + this.teacherFullName
                    + ' a question</a></li>');
            } else {
                //teacher = $('<li><a href="#" class="ask-teacher-sidebar" title="Login to use this feature">' + label + '</a>' + this.teacherFullName + '</li>');
                teacher = $('<li><a href="#" class="ask-teacher-sidebar" title="Login to use this feature"><i class="fa fa-question-circle"></i>Ask ' + this.teacherFullName + ' a question</a></li>');
            }
            teacher.appendTo(detailBox.find('.feedback ul'));
            counter++;
        }
    });
    if (counter == 0) {
        detailBox.find('.feedback').remove();
    } else {
        addTooltip('.detail-box .ask-teacher-sidebar', 'info', 'center', 'right', 'center', 'left');
        showLoginPanel('.detail-box .ask-teacher-sidebar');
    }

    // Comments
    if (sidebarShiurData.shiurComments?.length > 0) {
        // Comments holder
        var commentHolder = detailBox.find('.comment-area');
        // Number of comments
        commentHolder.find('.comments').html(sidebarShiurData.shiurCommentsNumber + ' comments');

        $.each(sidebarShiurData.shiurComments, function () {
            // Comment body
            var commentContainer = $('<li>');
            var commentContainerBody = '';
            commentContainerBody += '<div class="top-head">';
            commentContainerBody += '   <div class="box">';
            commentContainerBody += '     <div class="name-holder">';
            commentContainerBody += '        <strong class="name comment-title">Title: <span>' + this.commentTitle + '</span></strong><br>';
            commentContainerBody += '        <strong class="name comment-author">Author: <span>' + this.commentAuthor + '</span>,&nbsp;&nbsp;</strong>';
            commentContainerBody += '        <time class="date" datetime="' + this.commentDateFormatted + '">Date: <span>' + this.commentDate + '</span></time>';
            commentContainerBody += '     </div>';
            commentContainerBody += '   </div>';
            commentContainerBody += '</div>';
            commentContainerBody += '<div>' + this.commentBody + '</div>';
            $(commentContainerBody).appendTo(commentContainer);
            $(commentContainer).appendTo(commentHolder.find('ol.comment-list'));

            if (this.commentReplies?.length > 0) {
                var replyContainerLi = $('<li>');
                var replyContainerOl = $('<ol>');
                $.each(this.commentReplies, function () {
                    var replyContainer = $('<li>');
                    var replyContainerBody = '';
                    replyContainerBody += '<div class="top-head">';
                    replyContainerBody += '   <div class="box">';
                    replyContainerBody += '     <div class="name-holder">';
                    replyContainerBody += '        <strong class="name comment-title">Title: <span>' + this.commentTitle + '</span></strong><br>';
                    replyContainerBody += '        <strong class="name comment-author">Author: <span>' + this.commentAuthor + '</span></strong>';
                    replyContainerBody += '        <strong class="replyer comment-author">Author: <span>' + this.commentAuthor + '</span>,&nbsp;&nbsp;</strong>';
                    replyContainerBody += '        <time class="date" datetime="' + this.commentDateFormatted + '">Date: <span>' + this.commentDate + '</span></time>';
                    replyContainerBody += '     </div>';
                    replyContainerBody += '   </div>';
                    replyContainerBody += '</div>';
                    replyContainerBody += '<div>' + this.commentBody + '</div>';
                    $(replyContainerBody).appendTo(replyContainer);
                    replyContainer.appendTo(replyContainerOl);
                });
                replyContainerOl.appendTo(replyContainerLi);
                replyContainerLi.appendTo(commentHolder.find('ol.comment-list'));
            }
        });
        // If no comments delete elements
    } else {
        detailBox.find('.comments').parent().remove();
        detailBox.find('.comment-list').remove();
    }

    // Add shiur link to comment button
    detailBox.find('.btn-comment').attr('href', sidebarShiurData.shiurHref);

    // sidebar, tabs, slideshow calls
    createSidebarTabsControls();
    imgSlideShow(detailBox.find('.img-holder'));
    initFeaturedButtons(detailBox.find('.list .post'));
    initAjaxAsideSidebar(detailBox.find('.info-speaker .teacher'));
    initAjaxAsideSidebar(detailBox.find('.subsection-body .postedin'));
    if (!$.isEmptyObject(sidebarShiurData.shiurCollection)) {
        initAjaxAsideSidebarShiur(detailBox.find('.collection-list li'));
    }
    editShiur('.detail-box .tab-content');
    editShiur('.detail-box .person-head', 'sidebar');
    initFeaturedButtons(detailBox.find('.info'));

    // Notify Google Analytics
    notifyGoogleAnalytics('Shiur', 'Sidebar', sidebarShiurData.shiurTitle, sidebarShiurData.shiurID, sidebarShiurData.shiurLecturePageURL);

    //print by url
    $("li.print-sidebar>a").on("click", function () {
        var url = $(this).attr("data-href");
        console.log(url)
        var printWindow = window.open(url, 'Print', 'left=200, top=200, width=950, height=500, toolbar=0, resizable=0');
        printWindow.addEventListener('load', function () {
            printWindow.print();
            printWindow.close();
        }, true);
    })

    createSidebarAd($('.person-info'));
};

/**
 * 
 * JS Functions
 * 
 */
function hasNonEmptyProperties(obj) {
    for (var key in obj) {
        if (obj[key] !== null && obj[key] !== 0) {
            return true;
        }
    }
    return false;
}

var getPostedInSeries = function (data, seriesContainer, hideContainerIfEmpty) {
    if (data.postedInSeries?.length > 0) {
        $.each(data.postedInSeries, function (i, series) {
            series = '<a class="postedin" href="' + series.href + '" data-href="' + series.dataHref + '">' + series.seriesName + '</a>';
            if (data.postedInSeries.length != i + 1) {
                $(seriesContainer).append('&nbsp');
            }
            $(series).appendTo($(seriesContainer));
        });
    }
    if (hideContainerIfEmpty && (data.postedInSeries == null || data.postedInSeries.length == 0)) {
        $(seriesContainer).prev().hide();
        $(seriesContainer).hide();
    }
};

// Posted in venues
var getPostedInVenues = function (data, venuesContainer, hideContainerIfEmpty) {
    if (data.postedInLocations?.length > 0) {
        $.each(data.postedInLocations, function (i, venues) {
            venues = '<a class="postedin" href="' + venues.href + '" data-href="' + venues.dataHref + '">' + venues.locationName + '</a>';
            if (data.postedInLocations.length != i + 1) {
                $(venuesContainer).append('&nbsp');
            }
            $(venues).appendTo($(venuesContainer));
        });
    }
    if (hideContainerIfEmpty && (data.postedInLocations?.length == 0)) {
        $(venuesContainer).prev().hide();
        $(venuesContainer).hide();
    }
};

// Posted in categories
var getPostedInCategories = function (data, categoriesContainer, hideContainerIfEmpty) {
    if (!$.isEmptyObject(data.postedInCategories)) {
        var counter = 0;
        $.each(data.postedInCategories, function (categoryID, subcategories) {
            counter += 1;

            /*if (counter > 1) {
              $(categoriesContainer).append('&nbsp;');
            }*/

            var categories = '';

            // Add group name only if there's more than one sub-category
            if (subcategories['categories']?.length >= 1) {
                categories = '<div><div class="category-group-name">' + subcategories['groupName'] + ': </div><div class="posted-indent">';
            } else {
                if (counter > 1) {
                    $(categoriesContainer).append('&nbsp;');
                }
            }

            if (subcategories['categories']) {
                $.each(subcategories['categories'], function (i, subcategory) {
                    if (subcategories['categories']?.length != i + 1) {
                        categories += '<span><a class="postedin" href="' + subcategory.href + '" data-href="' + subcategory.dataHref + '">' + subcategory.categoryName + '</a>,</span>';
                        categories += '&nbsp';
                    } else {
                        categories += '<span><a class="postedin" href="' + subcategory.href + '" data-href="' + subcategory.dataHref + '">' + subcategory.categoryName + '</a></span>';
                    }

                    /*if (subcategories['categories'].length != i + 1) {
                      categories += ',&nbsp';
                    }*/
                });
            }
            // Process all sub-categories
            if (subcategories['categories']?.length >= 1) {
                categories += '</div></div>';
            }
            $(categories).appendTo($(categoriesContainer));
        });
    }

    if (hideContainerIfEmpty && $.isEmptyObject(data.postedInCategories)) {
        $(categoriesContainer).prev().hide();
        $(categoriesContainer).hide();
    }

};

//create sidebar tabs
function createSidebarTabsControls() {
    var tabs = $('.detail-box .tabs-heading ul li a');
    tabs.each(function () {
        var item = $(this);
        item.on('click', function () {
            $('.detail-box .tabs-heading ul li a').removeClass('active');
            $('.detail-box').scrollTo(item.attr('href'));
            item.addClass('active');
            return false;
        });
    });
}

//create sidebar player controls
function createSidebarPlayerControls(shiurID, playerStatus, calledFrom) {
    var container;
    if (calledFrom == 'daf') {
        container = '#jp_container_daf';
    } else if (calledFrom == 'lecture') {
        container = '#jp_container_lecture';
    } else if ($('.sidebar-shiur .person-head')?.length > 0) {
        container = '#jp_container';
    }

    //if clicked on sidebar or read from cookie
    var ID;
    if (shiurID != undefined) {
        ID = shiurID;
    } else {
        ID = sessionStorage.getItem('playingShiurID');
    }
    //add selectors for shiur player
    $("#jp_audio_sidebar").jPlayer({
        cssSelector:
        {
            seekBar: '.jp-seek-bar, ' + container + ' .jp-seek-bar',
            playBar: '.jp-play-bar, ' + container + ' .jp-play-bar',
            play: '.jp-play, ' + container + ' .jp-play, #jp-video .video-container, #jp-video-lecture .video-container',
            currentTime: '.jp-current-time, ' + container + ' .jp-current-time',
            duration: '.jp-duration,  ' + container + ' .jp-duration',
            volumeBar: '.jp-volume-bar, ' + container + ' .jp-volume-bar',
            volumeBarValue: '.jp-volume-bar-value, ' + container + ' .jp-volume-bar-value',
            mute: '.jp-mute,  ' + container + ' .jp-mute'
        }
    });

    //set player status and UI layout
    if (sessionStorage.getItem('playingShiurID') !== null) {
        playerSetStatus('play');
        $(container).addClass('jp-state-playing');
    } else {
        playerSetStatus('pause');
        $(container).removeClass('jp-state-playing');
    }

    //play button play/pause
    $(container + ' .jp-play, #jp-video .video-container, #jp-video-lecture .video-container').on('click', function () {
        $('#jp_audio_sidebar').jPlayer("pauseOthers");
        var isPaused = playerGetStatus();
        if (isPaused) {
            $(container).addClass('jp-state-playing');
            currentPlayingShiur = true;
            //first remove old cookie value and write new
            sessionStorage.removeItem('playingShiurID');
            sessionStorage.setItem('playingShiurID', ID);
            sessionStorage.removeItem('currentTime');
            sessionStorage.setItem('currentTime', playerGetCurrentTime());
        } else {
            $(container).removeClass('jp-state-playing');
            currentPlayingShiur = false;
            sessionStorage.removeItem('playingShiurID');
            sessionStorage.removeItem('currentTime');
        }
    });

    $('#jp_container_sidebar .jp-play').bind('click', function () {
        $('#jp_audio_sidebar').jPlayer("pauseOthers");
        var isPaused = playerGetStatus();
        if (isPaused) {
            $(container).addClass('jp-state-playing');
            currentPlayingShiur = true;
        } else {
            $(container).removeClass('jp-state-playing');
            currentPlayingShiur = false;
        }
    });
    //play button play/pause
    var volumeCreated = $(container + ' .jp-volume-bar').data('ui-slider');
    if (volumeCreated != undefined) {
        $(container + ' .jp-volume-bar').slider('destroy');
    }
    // add volume slider
    $(container + ' .jp-volume-bar').slider({
        value: $('#jp_container_sidebar .jp-volume-bar').slider('value'),
        max: 100,
        range: 'min',
        animate: true,
        orientation: "horizontal",
        slide: function (event, ui) {
            var volume = ui.value / 100;
            $("#jp_audio_sidebar").jPlayer("volume", volume);
            $('#jp_container_sidebar .jp-volume-bar').slider('value', (ui.value));
            $.cookie('currentVolume', volume, { path: '/' });
        }
    });

    //add seek slider
    var progressCreated = $(container + ' .jp-progress').data('ui-slider');
    if (progressCreated != undefined) {
        $(container + ' .jp-progress').slider('destroy');
    }
    $(container + ' .jp-progress').slider({
        animate: "fast",
        max: 100,
        range: "min",
        step: 0.1,
        value: 0,
        orientation: "horizontal",
        slide: function (event, ui) {
            var sp = $("#jp_audio_sidebar").data().jPlayer.status.seekPercent;
            if (sp > 0) {
                // Move the play-head to the value and factor in the seek percent.
                $("#jp_audio_sidebar").jPlayer("playHead", ui.value * (100 / sp));
            } else {
                // Create a timeout to reset this slider to zero.
                setTimeout(function () {
                    $(container + ' .jp-progress').slider("value", 0);
                }, 0);
            }
        }
    });

    /* audio play speed */
    var currentSpeedIdx = 1;
    var speeds = [0.5, 1, 1.5, 2.0];
    var speeds_text = ['0.5', '1.0', '1.5', '2.0'];
    $(document.body).on('click', '.jpSpeedControl', function () {
        console.log("click speed");
        currentSpeedIdx = currentSpeedIdx + 1 < speeds.length ? currentSpeedIdx + 1 : 0;
        $("#jp_audio_sidebar").jPlayer("option", "playbackRate", speeds[currentSpeedIdx]);
        jQuery(".jpSpeedControl>span").html(speeds_text[currentSpeedIdx] + 'x');
    });

    $("#jp_container_sidebar .jpSpeedControl").on('click', '', function () {
        console.log("click speed");
        currentSpeedIdx = currentSpeedIdx + 1 < speeds.length ? currentSpeedIdx + 1 : 0;
        $("#jp_audio_sidebar").jPlayer("option", "playbackRate", speeds[currentSpeedIdx]);
        jQuery(".jpSpeedControl>span").html(speeds_text[currentSpeedIdx] + 'x');
    });

    //mute/unmute button
    $(container + ' .jp-mute').on('click', function () {
        var isMuted = $("#jp_audio_sidebar").data().jPlayer.options.muted;
        if (isMuted) {
            $(container).addClass('jp-state-muted');
            $(container + ' .jp-volume-bar, #jp_container_sidebar .jp-volume-bar').slider("value", 0);
            $.cookie('currentVolume', 0, { path: '/' });
        } else {
            $(container).removeClass('jp-state-muted');
            var volume = $("#jp_audio_sidebar").data().jPlayer.options.volume;
            $(container + ' .jp-volume-bar, #jp_container_sidebar .jp-volume-bar').slider("value", volume * 100);
            $.cookie('currentVolume', volume, { path: '/' });
        }
    });

    $('#jp_container_sidebar .jp-volume-bar').slider({
        change: function (event, ui) {
            if (ui.value > 0) {
                $(container).removeClass('jp-state-muted');
                $('#jp_audio_sidebar').jPlayer("unmute");
                //$(container + ' .jp-volume-bar').slider("value", ui.value);
            }
        }
    });
    //mute/unmute button
}

//if sidebar is active and then user wants to go back to the Daf or Lecture shiur use this function
function recreateDafLecturePlayer() {
    var recreateId = '';
    var container = '';
    var callFrom = '';
    if ($('#jp_container_daf').length > 0) {
        container = '#jp_container_daf';
        callFrom = 'daf';
    } else if ($('#jp_container_lecture').length > 0) {
        container = '#jp_container_lecture';
        callFrom = 'lecture';
    }
    if (container != '') {
        $(container + ' .jp-play').bind('click', function () {
            recreateId = $(container).attr('data-id');
            if (playingShiurID != recreateId) {
                sessionStorage.removeItem('playingShiurID');
                sessionStorage.removeItem('currentTime');
                ajaxLoadContent('/sidebar/lecturedata?shiurID=' + recreateId, 'json', false, function (data) {
                    $(container).find('.jp-progress').slider('destroy');
                    $(container).find('.jp-volume-bar').slider('destroy');
                    initSidePlayer(data, callFrom, $(container).attr('data-time'));
                    sessionStorage.setItem('playingShiurID', data.shiurID);
                });
            }
        });
    }
}

//create player video tag
function createSidebarPlayerVideoContent() {
    if (playerVideo != '' && playerImg != '') {
        if ($('.jp-audio').hasClass('playing-shiur')) {
            $('.playing-shiur').parent().find('.video-container').html('');
            playerVideo.hide().appendTo($('.playing-shiur').parent().find('.video-container')).show();
            playerImg.hide().appendTo($('.playing-shiur').parent().find('.video-container')).show();
        }
    }
}

// return current Sidenav player time
function playerGetCurrentTime() {
    if (playerCreated === true) {
        var currentTime = $("#jp_audio_sidebar").data("jPlayer").status.currentTime;
        return currentTime;
    }
}

// return time saved in cookie
function cookieGetCurrentTime() {
    if (sessionStorage.getItem('currentTime') !== null) {
        var currentTime = parseFloat(sessionStorage.getItem('currentTime'));
        return currentTime;
    } else {
        return 0;
    }
}

// set Sidenav player status
function playerSetStatus(status, time) {
    $("#jp_audio_sidebar").jPlayer(status, time);
}

// return Sidenav player status
function playerGetStatus() {
    if (playerCreated === true) {
        var currentStatus = $("#jp_audio_sidebar").data("jPlayer").status.paused;
        return currentStatus; //true if paused, false if not
    }
}

// return Sidenav total time
function playerGetTotalTime() {
    if (playerCreated === true && totalDuration != 0) {
        return totalDuration;
    }
}

// call interface for isPlayed status
var sendIsPlayedData = function (action, e, totalTime, async) {
    if (playingShiurID != 'undefined') {
        var currentTime;
        if (totalTime) {
            currentTime = totalTime;
        } else {
            currentTime = playerGetCurrentTime();
        }
        var params;
        if (action == 'add') {
            params = {
                'action': action,
                'isPlayed': isPlayed,
                'lastPlayed': lastPlayed,
                'playerCurrentPosition': currentTime,
                'shiurID': playingShiurID
            };
        } else if (action == 'update') {
            params = {
                'action': action,
                'shiurMediaLengthFromPlayer': totalTime,
                'shiurID': playingShiurID
            };
        } else if (action == 'disableShiur') {
            params = {
                'action': action,
                'shiurID': playingShiurID
            };
        }
        var isAsync;
        if (async) {
            isAsync = async;
        } else {
            isAsync = false;
        }
        // Slavisa: TODO put email notification on error
        $.ajax({
            url: '/queue/player',
            cache: false,
            type: 'GET',
            data: params,
            dataType: 'json',
            async: isAsync,
            success: function (data) {
                if ($.isEmptyObject(data)) {
                    msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
                }
                if (data.errorMessage !== '') {
                    if (action == 'disableShiur') {
                        disableShiurHandler(data.errorMessage);
                    } else {
                        msgAlert(data.errorMessage, 'error');
                    }
                }
            },
            error: function (jqXHR, exception) {
                ajaxErrorHandler(jqXHR, exception);
            }
        });
        e = null;
    }
};

//show message for disabled shiur
function disableShiurHandler(errorMessage) {
    msgAlert(errorMessage, 'error');
    sessionStorage.removeItem('playingShiurID');
    $('.detail-box #jp-video').remove();
    $('.detail-box #jp_container').remove();
    $('.lecture-audio').slideUp('fast', function () { $(this).remove() });
    $('.sidenav .sidenav-player').hide();
    $('.sidenav .added-to-player').remove();
    $('#easy-open').remove();
    $('a[data-id="' + playingShiurID + '"]').unbind().removeAttr('href').parent().parent('.queue').find('a').unbind().removeAttr('href');
}

//change style to element on the page
function isPlayedChangeStyle() {
    $('a[data-id="' + playingShiurID + '"]').parents('.post, .holder').addClass('is-played');
}

//apply style to all isPlayed elements
function isPlayedApplyStyle() {
    $.each(userJSON.myPlayedList, function (i) {
        $.each($('a[data-id="' + userJSON.myPlayedList[i] + '"]'), function () {
            $(this).parents('.post').addClass('is-played');
        });
    });
}

//convert seconds to HH:MM:SS format
function SecondsToHMS(time) {
    time = Number(time);
    var val;
    var h = Math.floor(time / 3600);
    var m = Math.floor(time % 3600 / 60);
    var s = Math.floor(time % 3600 % 60);
    var hr = format(h, 'hours');
    var min = format(m, 'minutes');
    var sec = format(s, 'seconds');
    if (hr > 0) {
        val = hr + ':' + min + ':' + sec;
    } else {
        val = min + ':' + sec;
    }

    return val;

    function format(num, type) {
        var val;
        if (num > 0) {
            if (num >= 10) {
                val = num;
            } else {
                if (type != 'hours') {
                    val = '0' + num;
                } else {
                    val = num;
                }
            }
        } else {
            if (type != 'hours') {
                val = '00';
            } else {
                val = '0';
            }
        }

        return val;
    }
}

//move queue item from upcoming to in progress
function moveToInProgress(shiurID) {
    var length = $('.sidenav > ul > li.queue #tab1 .block[data-id="' + shiurID + '"]').length;
    if (length > 0) {
        if ((isPlayed == 1)) {
            sendIsPlayedData('add', '', '', true);
        }
        $('sidenav > ul > li.queue .queue-panel').addClass('loading');
        setTimeout(function () {
            refreshQueue('get', 000000, 'queue', 0, '');
        }, 500);
        callQueue = false;
        //set In Progress active
        $('.sidenav > ul > li.queue .tabset li a').removeClass('active');
        $('.sidenav > ul > li.queue .tabset li:first-child a').addClass('active');
        $('.sidenav > ul > li.queue .tab-content-inner').hide();
        $('.sidenav > ul > li.queue #tab2').show();
    }
}

//refresh Queue content for current active playing shiur
function updateQueueTime(shiurID, currentTime, totalTime) {
    var currentItem = $('.sidenav > ul > li.queue .queue-content .block[data-id="' + shiurID + '"]');
    $('.sidenav > ul > li.queue .queue-content .block').removeClass('active-playing');
    $('.sidenav > ul > li.queue .queue-content .block .textbox .tag').removeClass('active-playing');
    currentItem.addClass('active-playing');
    //disable play button
    $('.sidenav > ul > li.queue .queue-content .block .add .play a').show();
    currentItem.find('.add .play a').hide();
    if (currentItem.find('.textbox .tag[data-id="' + shiurID + '"]').length <= 0) {
        var tag = $('<div class="tag active-playing" data-id="' + shiurID + '"><div class="time-holder">' + currentTime + ' played</div><div class="progress-holder"></div></div>');
        tag.insertAfter(currentItem.find('.meta'));
    } else {
        currentItem.find('.textbox .tag[data-id="' + shiurID + '"]').addClass('active-playing');
        currentItem.find('.textbox .tag[data-id="' + shiurID + '"] > .time-holder').html(SecondsToHMS(currentTime) + ' played - ' + SecondsToHMS(totalTime) + ' total')
        currentItem.find('.textbox .tag[data-id="' + shiurID + '"] > .progress-holder').css('width', ((currentTime / totalTime * 100) + '%'));
    }
}

//automatically play next shiur from the queue
function playNextItemFromQueue(shiurID) {
    /*var currentItem = $('.sidenav > ul > li.queue #tab1 .block[data-id="' + shiurID +'"]');*/
    var currentItem = $('.sidenav > ul > li.queue .queue-content .block[data-id="' + shiurID + '"]');
    var nextItem = currentItem.next('.block').length;
    var nextItemID = '';
    var nextItemTime = 0;
    if (nextItem > 0) {
        nextItemID = currentItem.next('.block').attr('data-id');
        nextItemTime = currentItem.next('.block').find('.title a').attr('data-time');
    } else {
        nextItemID = $('.sidenav > ul > li.queue #tab1 .block:first-child').attr('data-id');
        nextItemTime = $('.sidenav > ul > li.queue #tab1 .block:first-child').find('.title a').attr('data-time');
    }
    sendIsPlayedData('add', '', totalDuration); // send time of previous shiur which is fully played
    currentItem.remove();
    setTimeout(function () {
        refreshQueueNumbers('queue');
    }, 250);
    if (($.inArray(parseInt(shiurID), queueList)) > -1) {
        refreshQueue('remove', shiurID, 'queue', 0, '');
        callHistory = false;
        callQueue = false;
    }
    sessionStorage.removeItem('playingShiurID');
    sessionStorage.removeItem('currentTime');
    if (nextItemID) {
        sessionStorage.setItem('playingShiurID', nextItemID);
        ajaxLoadContent('/sidebar/lecturedata?shiurID=' + nextItemID, 'json', false, function (data) {
            if (!$.isEmptyObject(data)) {
                initSidePlayer(data, '', nextItemTime);
                if ($('.detail-box').length > 0) {
                    $('.detail-box').remove();
                }
            }
        });
    }
}

//destroy player if removed from Queue
function destroyPlayerFromQueue(shiurID) {
    if (playingShiurID == shiurID) {
        $('#jp_audio_sidebar').jPlayer('stop');
        $('#jp_container_lecture, #jp_container, #jp_container_daf').removeClass('jp-state-playing');
        $('.sidenav ul li.sidenav-player .player').addClass('hide-element').css('display', 'none');
        sessionStorage.removeItem('playingShiurID');
        sessionStorage.removeItem('currentTime');
    }
}

//full screen for video content
function toggleFullScreen(container) {
    var playerId;
    if (container == '#jp-video') {
        playerId = '#jp_container';
    } else {
        playerId = '#jp_container_lecture';
    }
    var videoElement = $(container + ' video').get(0);
    if (!document.mozFullScreen && !document.webkitFullScreen) {
        if (videoElement.mozRequestFullScreen) {
            videoElement.mozRequestFullScreen();
        } else {
            videoElement.webkitRequestFullScreen(Element.ALLOW_KEYBOARD_INPUT);
        }
        $(container + ' video').attr('controls', 'controls');
        setTimeout(function () {
            playerSetStatus('play');
            $(playerId).addClass('jp-state-playing');
        }, 10);
    } else {
        $(playerId).removeClass('full-screen');
        if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else {
            document.webkitCancelFullScreen();
        }
        $(container + ' video').removeProp('controls');
    }

    $(document).keyup(function (e) {
        if (e.keyCode == 27)
            $(container + ' video').removeProp('controls');
    });

    // detect fullscreen change
    document.addEventListener("fullscreenchange", function () {
        $(container + ' video').removeProp('controls');
    }, false);

    document.addEventListener("mozfullscreenchange", function () {
        $(container + ' video').removeProp('controls');
    }, false);

    document.addEventListener("webkitfullscreenchange", function () {
        $(container + ' video').removeProp('controls');
    }, false);

    document.addEventListener("msfullscreenchange", function () {
        $(container + ' video').removeProp('controls');
    }, false);
}

// call Sidenav player
function initSidePlayer(data, calledFrom, playerTime, playerStatus) {
    if (!$.isEmptyObject(data) && data != undefined) {
        playerSetup(data, calledFrom, playerTime, playerStatus);
        //build side button for shiur being played
        createSideButton(data.shiurID);
    } else if (sessionStorage.getItem('playingShiurID') !== null) {
        var shiurID = sessionStorage.getItem('playingShiurID');
        // check if is lecture page
        if ($('#jp_container_lecture').length > 0) {
            if (!$.isEmptyObject(lecturePlayerData)) {
                playerSetup(lecturePlayerData, calledFrom);
                //build side button for shiur being played
                createSideButton(lecturePlayerData.shiurID);
            }
        } else {
            ajaxLoadContent('/sidebar/lecturedata?shiurID=' + shiurID, 'json', false, function (data) {
                if (!$.isEmptyObject(data)) {
                    playerSetup(data, calledFrom);
                    //build side button for shiur being played
                    createSideButton(data.shiurID);
                }
            });
        }
    }
}

function destroyPlayer() {
    msgAlert('Unfortunately this shiur has unsupported media type', 'error');
    sessionStorage.removeItem('playingShiurID');
    $('.detail-box #jp-video').remove();
    $('.detail-box #jp_container').remove();
    $('#easy-open').remove();
    $('.lecture-audio').slideUp('fast', function () { $(this).remove() });
    $('.sidenav .player').hide();
}

function playerSetMedia(data) {
    var setMedia,
        format = data.playerDownloadURL.slice(-3).toLowerCase(),
        link = data.playerDownloadURL;
    if (format == 'mp3') {
        setMedia = { title: data.shiurTitle, mp3: link };
    } else if (format == 'wav') {
        setMedia = { title: data.shiurTitle, wav: link };
    } else if (format == 'm4a') {
        setMedia = { title: data.shiurTitle, m4a: link };
    } else if (format == 'mp4') {
        setMedia = { title: data.shiurTitle, m4v: link };
    } else if (format == 'flv') {
        setMedia = { title: data.shiurTitle, flv: link };
    } else {
        setMedia = { title: data.shiurTitle, 'none': link };
        destroyPlayer();
    }
    return setMedia;
}

function playerUpdateMedia(data) {
    var media = playerSetMedia(data),
        time = cookieGetCurrentTime();
    $('#jp_audio_sidebar').jPlayer('clearMedia');
    $('#jp_audio_sidebar').jPlayer('setMedia', media);
    $('#jp_audio_sidebar').jPlayer('play', time);
}

function playerLoadingIndicator(state) {
    var box = $('.sidenav');
    var player = box.find('.sidenav-player');
    if (state == 'set') {
        player.addClass('loading');
        var text = '<div class="added-to-player">Loading/Resuming</div>';
        if ($('.added-to-player').length > 0) {
            $('.added-to-player').remove();
            $(text).fadeIn('slow').prependTo(box);
        } else {
            $(text).fadeIn('slow').prependTo(box);
        }
    }
    if (state == 'remove') {
        $('.added-to-player').fadeOut('slow').remove();
        player.removeClass('loading');
    }
}

var refreshSponsorhipLink = function () {
    $.ajax({
        url: 'https://api.yutorah.org/browse/sponsorship/audio',
        type: 'get',
        cache: false,
        dataType: 'html',
        async: false,
        success: function (data) {
            //console.log(data);
            //'http://cdn.yutorah.net/_media/sponsorshipAudio/122115.mp3';
            _sponsorshipAudioURL = data;
        },
        error: function (jqXHR, exception) {
            ajaxErrorHandler(jqXHR, exception);
        }
    });
};

// setup Sidenav player
function playerSetup(data, calledFrom, playerTime, playerStatus) {
    //refresh sponsorship link
    refreshSponsorhipLink();

    var currentTime;
    if (playerTime != '' && playerTime != undefined) {
        currentTime = playerTime * 1; // convert to number
    } else {
        currentTime = cookieGetCurrentTime();
    }

    var containerHolder;
    if (calledFrom == 'daf') {
        containerHolder = '#jp_container_daf';
    } else if (calledFrom == 'lecture') {
        containerHolder = '#jp_container_lecture';
    } else if ($('.sidebar-shiur .person-head').length > 0) {
        containerHolder = '#jp_container';
    }

    var shiurID = data.shiurID;
    //var link = data.playerDownloadURL;

    //if previus is played send data
    if ((isPlayed == 1) && (lastPlayed == 1) /*&& (($.inArray(playingShiurID, userJSON.myPlayedList)) == -1)*/) {
        sendIsPlayedData('add');
        isPlayed = 0;
    }

    //change style function on time update and call function just once
    var onceIsPlayedChangeStyle = once(function () {
        isPlayedChangeStyle();
    });

    var onceMoveToInProgress = once(function (shiurID) {
        moveToInProgress(shiurID);
    });

    //add current playing shiur to queue
    var onceAddToQueuePlayingShiur = once(function () {
        if (($.inArray(parseInt(shiurID), queueList)) <= -1) {
            refreshQueue('add', shiurID, 'queue', 0, '');
            callQueue = false;
        }
    });

    //read the volume cookie if exsist, if not create one
    var volume;
    if ($.cookie('currentVolume')) {
        volume = $.cookie('currentVolume');
    } else {
        volume = 1;
        $.cookie('currentVolume', 1, { path: '/' });
    }

    //new shiurID
    playingShiurID = shiurID;

    //show sidenav player button below queue
    $('.sidenav .player').fadeIn('fast').show().removeClass('hide-element');

    $('.sidenav .jp-type-single').on('click', function () {
        $('#jp_audio_sidebar').jPlayer("pauseOthers");
        return false;
    });

    //on hover slide out the player content and controls
    $('.sidenav .player').on('mouseenter', function () {
        $(this).addClass('active');
        $(this).find('.player-desc').addClass('active');
    });
    $('.sidenav .player').on('mouseleave', function () {
        $(this).removeClass('active');
        $(this).find('.player-desc').removeClass('active');
    });

    //if user is on daf page pause the sideplayer
    var playerStatus = playerStatus;
    if (($('#jp_audio_daf').length > 0) && pauseOtherPlayers === false) {
        playerStatus = 'pause';
    }
    else if (playerStatus == 'pause') {
        playerStatus = 'pause';
    }
    else {
        playerStatus = 'play';
    }

    // if is mobile device change to pause state
    if (isMobile() == true) {
        playerStatus = 'pause';
    }

    //check audio/video format
    var format,
        videoWidth = 0,
        videoHeight = 0;
    if (data.shiurNeedsToBeEmbed == 0) {
        format = data.playerDownloadURL.slice(-3).toLowerCase();
    } else {
        format = 'none';
        msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
    }

    //if video
    if (format == 'mp4') {
        format = 'm4v';
    }
    if (format == 'm4v' || format == 'flv') {
        videoWidth = '100%';
        videoHeight = '300px';
    }

    //create appropriate media object
    var setMedia;
    if ((sessionStorage.getItem('sponsorship') === null) && (_sponsorshipAudioURL != '')) {
        setMedia = { title: 'Learning on the site today`s sponsorship ', mp3: _sponsorshipAudioURL };
        var date = new Date();
        var minutes = 1;
        date.setTime(date.getTime() + (minutes * 60 * 1000));
        sessionStorage.setItem('sponsorship', 1);
        sponsorshipAudioStatus = 1;
        format = 'mp3';
        currentTime = 0;
        currentTeacherSponsorIndex = 0; // Reset teacher sponsor index
    } else {
        // Check if we should play teacher sponsorship first
        if (data.teacherSponsor != null && data.teacherSponsor.length > 0) {
            setMedia = { title: 'Teacher sponsorship', mp3: data.teacherSponsor[0].sponsorAudioMessage };
            teacherSponsorAudioStatus = data.teacherSponsor.length;
            teacherSponsorAudios = data.teacherSponsor;
            currentTeacherSponsorIndex = 1; // We're playing the first one
            format = 'mp3';
            currentTime = 0;
        } else {
            setMedia = playerSetMedia(data);
            sponsorshipAudioStatus = 0;
            teacherSponsorAudioStatus = 0;
            currentTeacherSponsorIndex = 0;
        }
    }

    if (data.teacherSponsor != null && data.teacherSponsor.length > 0) {
        teacherSponsorAudioStatus = data.teacherSponsor.length;
        teacherSponsorAudios = data.teacherSponsor;
    }

    console.log("ShiurData:", data);

    //destroy previous player event and stop downloading the file
    $('#jp_audio_sidebar').jPlayer('destroy');
    $('#jp_audio_sidebar').jPlayer('clearMedia');
    $('.jp-play').unbind();
    $('.jp-audio').removeClass('jp-state-playing');
    $('#jp_container_daf .jp-volume-bar, #jp_container_lecture .jp-volume-bar').unbind();
    $('#jp_container_daf .jp-progress, #jp_container_lecture .jp-progress').unbind();
    $('#jp_container_daf .jp-current-time, #jp_container_lecture .jp-current-time').html(SecondsToHMS(currentPlayerTime));
    $('#jp_container_daf .jp-duration, #jp_container_lecture .jp-duration').html(SecondsToHMS(totalDuration));
    recreateDafLecturePlayer();
    //$('#jp_audio_sidebar').jPlayer('setMedia', setMedia)
    $('.jp-audio').removeClass('playing-shiur');
    $('.jp-audio[data-id="' + playingShiurID + '"]').addClass('playing-shiur');

    //create new player
    var playerReady = false;
    $('#jp_audio_sidebar').jPlayer({
        ready: function () {
            $(this).jPlayer('setMedia', setMedia)
                .jPlayer(playerStatus, currentTime).jPlayer('volume', volume);
            //append video content vars
            playerVideo = $(this).find('video').detach();
            playerImg = $(this).find('img').detach().attr('src', _cdnPublicURL + 'images/video-bg.jpg');
            sessionStorage.removeItem('playingShiurID');
            /*if((isMobile() == false)) {*/
            sessionStorage.setItem('playingShiurID', shiurID);
            /*}  */
        },
        loadeddata: function (event) {
            if (sponsorshipAudioStatus == 0) {

                if (teacherSponsorAudioStatus == 1) {

                }

                totalDuration = event.jPlayer.status.duration;
                if (data.shiurMediaLengthIsUpdated == 0) {
                    if (totalDuration > 0) {
                        sendIsPlayedData('update', '', totalDuration, true);
                    }
                }
                if (playerStatus == 'play') {
                    $(containerHolder).addClass('jp-state-playing');
                }
                createSidebarPlayerVideoContent();
            }
            playerLoadingIndicator('remove');
            playerReady = true;
        },
        loadstart: function (event) {
            // needs to be improved
            //playerLoadingIndicator('set');
        },
        waiting: function (event) {
            playerLoadingIndicator('set');
        },
        playing: function (event) {
            playerLoadingIndicator('remove');
        },
        timeupdate: function (event) {
            currentPlayerTime = playerGetCurrentTime();
            if (containerHolder == '#jp_container') {
                containerHolder = '#jp_container.playing-shiur';
            }

            var disabled;
            if (sponsorshipAudioStatus == 1) {
                disabled = true;
                $('.jp-seek-bar').hide();
            } else {
                disabled = false;
                $('.jp-seek-bar').show();
            }

            $('#jp_container_sidebar .jp-progress, #jp_container.playing-shiur .jp-progress, #jp_container_lecture.playing-shiur .jp-progress, #jp_container_daf.playing-shiur .jp-progress').slider({
                animate: true,
                max: 100,
                range: 'min',
                step: 0.1,
                value: event.jPlayer.status.currentPercentAbsolute,
                disabled: disabled
            });
            //Add class to the active queue item
            $('.sidenav > ul > li.queue .queue-content .block').removeClass('active-playing');
            $('.sidenav > ul > li.queue .queue-content .block[data-id="' + shiurID + '"]').addClass('active-playing');
            if (sponsorshipAudioStatus == 0) {
                //check if time is between first 30s and last 30s
                if (playerGetCurrentTime() >= 30) {
                    //set Queue and History to false to enable queue/history refresh
                    //callQueue = false;
                    //callHistory = false;
                    isPlayed = 1;
                    //change style to element on the page
                    onceIsPlayedChangeStyle();
                    //refresh Queue content for current active playing shiur
                    updateQueueTime(shiurID, playerGetCurrentTime(), totalDuration);
                } else {
                    isPlayed = 0;
                }

                if (playerGetCurrentTime() >= (totalDuration - 30)) {
                    lastPlayed = 0;
                } else {
                    lastPlayed = 1;
                }
                //add current playing shiur to queue
                if (playerGetCurrentTime() >= 0.0001) {
                    onceAddToQueuePlayingShiur();
                }
                // check if queue is loaded the GUI
                if (queueGet == 1) {
                    onceMoveToInProgress(shiurID);
                    queueGet = 0;
                } else {
                    if (playingShiurID == shiurID) {
                        onceMoveToInProgress(shiurID);
                    }
                }
            }
        },
        ended: function (event) {
            if (sponsorshipAudioStatus == 1) {
                // Sponsorship ended, check if there are teacher sponsorships
                sponsorshipAudioStatus = 0;

                if (teacherSponsorAudioStatus > 0 && teacherSponsorAudios && teacherSponsorAudios.length > 0) {
                    // Play first teacher sponsorship
                    currentTeacherSponsorIndex = 1;
                    var teacherSponsorMedia = { title: 'Teacher sponsorship', mp3: teacherSponsorAudios[0].sponsorAudioMessage };
                    $('#jp_audio_sidebar').jPlayer('setMedia', teacherSponsorMedia).jPlayer('play');
                } else {
                    // No teacher sponsorships, play the actual shiur
                    playerUpdateMedia(data);
                }
            } else if (currentTeacherSponsorIndex > 0 && currentTeacherSponsorIndex < teacherSponsorAudioStatus) {
                // A teacher sponsorship ended, play the next one
                var nextTeacherSponsorMedia = { title: 'Teacher sponsorship', mp3: teacherSponsorAudios[currentTeacherSponsorIndex].sponsorAudioMessage };
                currentTeacherSponsorIndex++;
                $('#jp_audio_sidebar').jPlayer('setMedia', nextTeacherSponsorMedia).jPlayer('play');
            } else if (currentTeacherSponsorIndex > 0 && currentTeacherSponsorIndex >= teacherSponsorAudioStatus) {
                // All teacher sponsorships ended, play the actual shiur
                currentTeacherSponsorIndex = 0;
                teacherSponsorAudioStatus = 0;
                playerUpdateMedia(data);
            } else {
                // Actual shiur ended, play next from queue
                playNextItemFromQueue(shiurID);
                $(containerHolder).removeClass('jp-state-playing');
            }
        },
        error: function (event) {
            //console.log(event.jPlayer.error);
            //console.log(event.jPlayer.error.type);
            if (event.jPlayer.error.type == 'e_no_support') {
                setTimeout(function () {
                    msgAlert('There was an error loading audio content. Please try again in a few minutes.', 'error');
                    sessionStorage.removeItem('playingShiurID');
                    $('.detail-box #jp-video').remove();
                    $('.detail-box #jp_container').remove();
                    $('.lecture-audio').slideUp('fast', function () { $(this).remove() });
                    $('.sidenav .player').hide();
                    $('#easy-open').remove();
                }, 500);
            }
            if (event.jPlayer.error.type == 'e_url') {
                var shouldDisableShiur = true;
                if (event.jPlayer.error.context != 'pause' && event.jPlayer.error.context != 'play') {
                    if (event.jPlayer.error.message == 'Media URL could not be loaded.') {
                        shouldDisableShiur = true;
                    } else {
                        shouldDisableShiur = false;
                    }
                }

                // check if data is loaded
                if (!playerReady) {
                    shouldDisableShiur = true;
                } else {
                    shouldDisableShiur = false;
                }

                if (shouldDisableShiur) {
                    sendIsPlayedData('disableShiur', '', '', true);
                }
            }
        },
        cssSelectorAncestor: '#jp_container_sidebar',
        swfPath: _cdnPublicURL + 'js/audio',
        supplied: /* format */ 'mp3, m4a, wav, m4v, flv',
        useStateClassSkin: true, //if true then css will change UI
        autoBlur: false,
        smoothPlayBar: true,
        keyEnabled: false,
        loop: false,
        remainingDuration: false, //if true calculate remaining duration
        toggleDuration: false, //when true, clicks on the duration GUI element toggles the jPlayer({remainingDuration}) option
        /*errorAlerts: true,*/
        size: {
            width: videoWidth,
            height: videoHeight
        },
        preload: 'auto' //auto, none, metadata
    });

    //player is created successfully
    playerCreated = true;

    //reset size because of styling
    $('#jp_audio_sidebar').css({ 'width': '0px', 'height': '0px' });

    $('.jp-full-screen-link').unbind();
    $('.jp-full-screen-link').on('click', function () {
        var isSidebar = $(this).attr('data-sidebar');
        if (isSidebar == 1) {
            toggleFullScreen('#jp-video');
        } else {
            toggleFullScreen('#jp-video-lecture');
        }
    });

    //if we are on the daf page and main player is on and then sidebar is active then pause the main player
    if (playerStatus == 'play') {
        $('#jp_audio_sidebar').jPlayer("pauseOthers");
    }

    //add slider to volume control
    $('#jp_container_sidebar .jp-volume-bar').slider({
        value: volume * 100,
        max: 100,
        range: 'min',
        animate: true,
        orientation: "vertical",
        slide: function (event, ui) {
            var volume = ui.value / 100;
            $('#jp_audio_sidebar').jPlayer('volume', volume);
            $(containerHolder + ' .jp-volume-bar').slider('value', (ui.value));
            $('#jp_container.playing-shiur .jp-volume-bar, #jp_container_lecture.playing-shiur .jp-volume-bar, #jp_container_daf.playing-shiur .jp-volume-bar').slider('value', (ui.value));
            $.cookie('currentVolume', volume, { path: '/' });
            if (ui.value > 0) {
                $('#jp_container').removeClass('jp-state-muted');
                $('#jp_audio_sidebar').jPlayer("unmute");
            }
        }
    });

    //add seek slider
    $('#jp_container_sidebar .jp-progress').slider({
        animate: "fast",
        max: 100,
        range: "min",
        step: 0.1,
        value: 0,
        orientation: "horizontal",
        slide: function (event, ui) {
            var sp = $("#jp_audio_sidebar").data().jPlayer.status.seekPercent;
            if (sp > 0) {
                $("#jp_audio_sidebar").jPlayer("playHead", ui.value * (100 / sp));
            } else {
                $('#jp_audio_sidebar .jp-progress').slider("value", 0);
            }
        }
    });

    //write cookie based on player status
    $('#jp_container_sidebar .jp-play').on('click', function () {
        var isPaused = playerGetStatus();
        /*if((isMobile() == false)) {*/
        if (isPaused) {
            //first remove old cookie value and write new
            //$.removeCookie('playingShiurID', {path: '/'});
            sessionStorage.removeItem('playingShiurID');
            //$.cookie('playingShiurID', shiurID, {path: '/'});
            sessionStorage.setItem('playingShiurID', shiurID);
            /*$.removeCookie('currentTime', {path: '/'});
            $.cookie('currentTime', playerGetCurrentTime(), {path: '/'});*/
            sessionStorage.removeItem('currentTime');
            sessionStorage.setItem('currentTime', playerGetCurrentTime());
        } else {
            //$.removeCookie('playingShiurID', {path: '/'});
            sessionStorage.removeItem('playingShiurID');
            //$.removeCookie('currentTime', {path: '/'});
            sessionStorage.removeItem('currentTime');
            /*}*/
        }
    });

    $('#jp_container_sidebar .jp-mute').on('click', function () {
        setTimeout(function () {
            var isMuted = $("#jp_audio_sidebar").data().jPlayer.options.muted;
            if (isMuted) {
                $(containerHolder).addClass('jp-state-muted');
                $('#jp_container.playing-shiur, #jp_container_lecture, #jp_container_daf').addClass('jp-state-muted');
                $(containerHolder + ' .jp-volume-bar, #jp_container_sidebar .jp-volume-bar').slider("value", 0);
                $('#jp_container.playing-shiur .jp-volume-bar, #jp_container_lecture.playing-shiur .jp-volume-bar, #jp_container_daf.playing-shiur .jp-volume-bar').slider("value", 0);
                $.cookie('currentVolume', 0, { path: '/' });
            } else {
                $(containerHolder).removeClass('jp-state-muted');
                $('#jp_container.playing-shiur, #jp_container_lecture, #jp_container_daf').removeClass('jp-state-muted');
                var volume = $("#jp_audio_sidebar").data().jPlayer.options.volume;
                $(containerHolder + ' .jp-volume-bar, #jp_container_sidebar .jp-volume-bar').slider("value", volume * 100);
                $('#jp_container.playing-shiur .jp-volume-bar, #jp_container_lecture.playing-shiur .jp-volume-bar, #jp_container_daf.playing-shiur .jp-volume-bar').slider("value", volume * 100);
                $.cookie('currentVolume', volume, { path: '/' });

            }
        }, 20);
    });

    //on click rewind for 15s
    $('#jp_container_sidebar .jp-repeat').on('click', function () {
        var rewindTime = playerGetCurrentTime() - 15;
        if (rewindTime > 0) {
            playerSetStatus('play', rewindTime);
        } else {
            playerSetStatus('play', 0);
        }
    });

    //create controls for sidebar/lecture player
    if (($('.sidebar-shiur .person-head').length <= 0) && ($('#jp_container_lecture[data-id="' + data.shiurID + '"]').length > 0)) {
        calledFrom = 'lecture';
    }
    if (($('.sidebar-shiur .person-head').length <= 0) && ($('#jp_container_daf[data-id="' + data.shiurID + '"]').length > 0)) {
        calledFrom = 'daf';
    }
    createSidebarPlayerControls(shiurID, playerStatus, calledFrom);

    // if is mobile device change to pause state
    if (isMobile() == true) {
        $('.jp-audio').removeClass('jp-state-playing');
    }

    //create player content
    $('.sidenav .player-info p').hide();
    var container = $('.sidenav .player').find('.player-desc');
    container.html('');
    var title = $('<h3><a class="shiur" href="' + data.shiurHref + '" data-href="/sidebar/lecturedata?shiurID=' + data.shiurID + '">' + data.shiurTitle + '</a></h3>');
    title.appendTo(container);

    var teacherTime = $('<p>');
    if (data.shiurTeachers.length >= 1) {
        $.each(data.shiurTeachers, function (i) {
            var newteacher = '<a class="teacher" href="' + data.shiurTeachers[i].landingPageURL + '" data-href="/teachers/sidebar/' + data.shiurTeachers[i].teacherID + _svnRevision + '">' + data.shiurTeachers[i].teacherFullName + '</a>';
            if (data.shiurTeachers.length != i + 1) {
                $(newteacher).appendTo(teacherTime).after(', ');
            }
            if (data.shiurTeachers.length == i + 1) {
                $(newteacher).appendTo(teacherTime).after(' - ');
            }
        });
    }

    var date = '<span>' + data.shiurDateText + '</span>';
    $(date).appendTo(teacherTime);

    if (data.shiurDuration) {
        var duration = '<span>' + data.shiurDuration + '</span>';
        $(duration).appendTo(teacherTime).before(' - ');
    }
    $(teacherTime).appendTo(container);

    if (data.shiurDescription !== '') {
        var desc = '<p><strong>Description: </strong>' + data.shiurDescription + '</p>';
        $(desc).appendTo(container).css({ 'max-height': '38px', 'overflow': 'hidden', 'margin-bottom': '2px' });
    }

    //var postedIn = $('<p><strong>Posted in: </strong></p>');
    var postedIn = $('<p>');

    // Posted in series
    if (data.postedInSeries?.length > 0) {
        $(postedIn).append('Series: ');
    }
    getPostedInSeries(data, postedIn, false);
    if (data.postedInSeries?.length > 0) {
        $(postedIn).append('&nbsp;');
    }

    // Posted in venues
    if (data.postedInLocations?.length > 0) {
        $(postedIn).append('Venue: ');
    }
    getPostedInVenues(data, postedIn, false);
    if (data.postedInLocations?.length > 0) {
        $(postedIn).append('&nbsp;');
    }

    // Posted in categories
    getPostedInCategories(data, postedIn, false);

    // Add it to the main container if there are either series or categories
    if ((data.postedInSeries?.length > 0) || (!$.isEmptyObject(data.postedInCategories))) {
        $(postedIn).appendTo(container).css({ 'max-height': '38px', 'overflow': 'hidden' });
    }

    if ((playingShiurID != ($('#jp_container_lecture').attr('data-id'))) && (playingShiurID != ($('#jp_container_daf').attr('data-id')))) {
        initAjaxAsideSidebarShiur('#jp_container_sidebar .player-desc h3', 'player-on');
    } else {
        $('#jp_container_sidebar .player-desc h3 a').unbind().removeAttr('data-href').removeAttr('href');
    }
    initAjaxAsideSidebar('#jp_container_sidebar .player-desc .teacher, #jp_container_sidebar .player-desc .postedin');

    // add download button
    if (userAuthenticated == 1) {
        if (data.shiurCanBeDownloaded == 1 && data.downloadURL != '') {
            $('#player-download > a').attr('href', data.downloadURL);
        } else {
            $('#player-download > a').addClass('disable');
        }
    } else {
        $('#player-download > a').addClass('disable');
    }
    if (userAuthenticated == 1) {
        $('#player-download > a').on('click', function () {
            if ($(this).attr('href') != '#') {
                urchin_logDownload(shiurID, '', '0');
                window.location.href = $(this).attr('href');
            }
        });
    } else {
        $('#player-download > a').off();
        showLoginPanel($('#player-download > a'));
    }
}

//build sidebar button for shiur being played
function createSideButton(shiurID) {
    if ((windowWidth > 1023) && (isMobile() == false)) {
        //if clicked on sidebar or read from cookie
        //show only if not lecture page
        if ($('#jp_container_lecture').length <= 0 && $('#jp_container_daf').length <= 0) {
            if ($('#easy-open').length <= 0) {
                var easyOpen = $('<div class="easy-open" id="easy-open"><a class="shiur" href="#" data-href="/sidebar/lecturedata?shiurID=' + shiurID + '" title="Show current shuir sidebar">Open Shiur Sidebar</div>');
                easyOpen.fadeIn('slow').prependTo('.body-box');
                $('#easy-open a').unbind();
                initAjaxAsideSidebarShiur($('#easy-open'), 'player-on');

            } else {
                $('#easy-open a').attr('data-href', '/sidebar/lecturedata?shiurID=' + shiurID);
                $('#easy-open a').unbind();
                initAjaxAsideSidebarShiur($('#easy-open'), 'player-on');
            }
        }
    }
}

//start playing sidenav player effect
function playerAddEffect() {
    var text = '<div class="added-to-player">Player Controls</div>';
    var box = $.find('.sidenav');
    if ($('.added-to-player').length <= 0) {
        $(text).fadeIn('slow').prependTo(box).delay(2000).fadeOut('slow', function () {
            $(this).remove();
        });
    }
}

//show sidebar on click imidiatelly
function showSidebar() {
    var main = $('#wrapper');
    var page = $('html, body');
    var isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent);
    var animSpeed = 500;
    var body = $('body');

    var detailBox = $('<div class="detail-box">');
    var loader = $('<div id="loading-sidebar"></div>');
    loader.appendTo(detailBox);

    detailBox.css({
        right: '-100%'
    });
    if (detailBox.length) {
        window.picturefill();
        $('.detail-box').remove();
        detailBox.appendTo(body);

        detailBox.css({
            right: ''
        });

        if (isWinPhoneDevice) {
            page.scrollTop(position);
        } else {
            page.stop().animate({
                scrollTop: detailBox.offset().top
            }, {
                duration: animSpeed,
                complete: function () {
                    if (main.height() < detailBox.height()) {
                        main.css({ height: detailBox.height() });
                        initSameHeight();
                    }
                }
            });
        }
    }
}

// add/remove/get teachers/series/venues from/to favorites
function updateFavorites(action, myFavoriteType, myFavoriteID) {
    var params = {
        'action': action,
        'myFavoriteType': myFavoriteType,
        'myFavoriteID': myFavoriteID
    };
    // Slavisa: TODO put email notification on error
    $.ajax({
        url: '/Account/UserFavorites',
        cache: false,
        type: 'POST',
        data: params,
        dataType: 'json',
        async: false,
        success: function (data) {
            if ($.isEmptyObject(data)) {
                msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
            }
            else if (data.errorMessage !== '') {
                msgAlert(data.errorMessage, 'error');
            } else {
                userJSON.myFavoriteTeachers = data.myFavoriteTeachers;
                userJSON.myFavoriteSeries = data.myFavoriteSeries;
                userJSON.myFavoriteLocations = data.myFavoriteLocations;
                userJSON.myFavoritePublications = data.myFavoritePublications;
                userJSON.myFavoriteCollections = data.myFavoriteCollections;
                userJSON.myCustomCollections = data.myCustomCollections;
            }
        },
        error: function (jqXHR, exception) {
            ajaxErrorHandler(jqXHR, exception);
        }
    });
}

//load favorites
function loadFavorites() {
    if (userAuthenticated == 1) {
        updateFavorites("none", "none", 0);
        //check if already active
        $.each(userJSON.myFavoriteTeachers, function (i) {
            $.each($('a[data-id="' + userJSON.myFavoriteTeachers[i].teacherID + '"]'), function () {
                $(this).addClass('active').attr('title', 'Remove from Favorites');
            });
        });
        $.each(userJSON.myFavoriteSeries, function (i) {
            $.each($('a[data-id="' + userJSON.myFavoriteSeries[i].seriesID + '"]'), function () {
                $(this).addClass('active').attr('title', 'Remove from Favorites');
            });
        });
        $.each(userJSON.myFavoriteLocations, function (i) {
            $.each($('a[data-id="' + userJSON.myFavoriteLocations[i].locationID + '"]'), function () {
                $(this).addClass('active').attr('title', 'Remove from Favorites');
            });
        });
        $.each(userJSON.myFavoritePublications, function (i) {
            $.each($('a[data-id="' + userJSON.myFavoritePublications[i].publicationID + '"]'), function () {
                $(this).addClass('active').attr('title', 'Remove from Favorites');
            });
        });
        $.each(userJSON.myFavoriteCollections, function (i) {
            $.each($('a[data-id="' + userJSON.myFavoriteCollections[i].ID + '"]'), function () {
                $(this).addClass('active').attr('title', 'Remove from Favorites');
            });
        });
    }
}

//refresh favorites everywhere
function refreshFavorites(action, id, calledFrom) {
    if (calledFrom) {
        loadFavoriteTeachers('#' + calledFrom);
        loadFavoriteSeries('#' + calledFrom);
        loadFavoriteVenues('#' + calledFrom);
        loadFavoritePublications('#' + calledFrom);
    } else {
        loadFavoriteTeachers('#nav');
        loadFavoriteSeries('#nav');
        loadFavoriteVenues('#nav');
        loadFavoritePublications('#nav');
    }
    if (action == 'remove') {
        /*if(calledFrom != 'nav'){
          loadFavoriteTeachers('#nav');
          loadFavoriteSeries('#nav');
        }*/
        $('a[data-id="' + id + '"]').removeClass('active').attr('title', 'Add to Favorites').qtip('option', 'content.text', 'Add to Favorites');
        $('.detail-box').find('a[data-id="' + id + '"]').html('Add to Favorites');
    } else if (action == 'add') {
        /*loadFavoriteTeachers('#nav');
        loadFavoriteSeries('#nav');*/
        $('a[data-id="' + id + '"]').addClass('active').attr('title', 'Remove from Favorites').qtip('option', 'content.text', 'Remove from Favorites');
        $('.detail-box').find('a[data-id="' + id + '"]').html('Remove from Favorites');
    }
}

//landing page add to favories
function addToFavoritesFromLanding() {
    var button = $('#landing-add-to-fav');
    if (button.length > 0) {
        if (userAuthenticated == 1) {
            var id = button.attr('data-id');
            var mode = button.attr('data-mode');

            //on click action
            button.on('click', function () {
                if ($(this).hasClass('active')) {
                    updateFavorites('remove', mode, id);
                    refreshFavorites('remove', id);
                } else {
                    if (mode == 'teacher') {
                        if (userJSON.myFavoriteTeachers.length <= 4) {
                            updateFavorites('add', mode, id);
                            refreshFavorites('add', id);
                        } else {
                            msgAlert('You have reached maximum of 5 Favorite Teachers', 'good');
                        }
                    }
                    if (mode == 'series') {
                        if (userJSON.myFavoriteSeries.length <= 4) {
                            updateFavorites('add', mode, id);
                            refreshFavorites('add', id);
                        } else {
                            msgAlert('You have reached maximum of 5 Favorite Series', 'good');
                        }
                    }
                    if (mode == 'venues') {
                        if (userJSON.myFavoriteLocations.length <= 4) {
                            updateFavorites('add', 'locations', id);
                            refreshFavorites('add', id);
                        } else {
                            msgAlert('You have reached maximum of 5 Favorite Venues', 'good');
                        }
                    }

                    if (mode == 'collections') {
                        if (userJSON.myFavoriteCollections.length <= 4) {
                            updateFavorites('add', 'collections', id);
                            refreshFavorites('add', id);
                        } else {
                            msgAlert('You have reached maximum of 5 Favorite Collections', 'good');
                        }
                    }
                }
                //refreshFavorites(id);
            });
        } else {
            showLoginPanel(button);
            button.attr('title', 'Login to use this feature').addClass('disable');
        }
        addTooltip('#landing-add-to-fav', 'info');
    }
}

//lecture page add to favories
function addToFavoritesFromLecture() {
    var buttons = $('.lecture-page .lecture-add-to-fav');
    if (buttons.length > 0) {
        if (userAuthenticated == 1) {
            //on click action
            buttons.each(function () {
                var item = $(this);
                var id = item.attr('data-id');
                var mode = item.attr('data-mode');
                item.on('click', function () {
                    if ($(this).hasClass('active')) {
                        updateFavorites('remove', mode, id);
                        refreshFavorites('remove', id);
                    } else {
                        if (mode == 'teacher') {
                            if (userJSON.myFavoriteTeachers.length <= 4) {
                                updateFavorites('add', mode, id);
                                refreshFavorites('add', id);
                            } else {
                                msgAlert('You have reached maximum of 5 Favorite Teachers', 'good');
                            }
                        }
                        if (mode == 'series') {
                            if (userJSON.myFavoriteSeries.length <= 4) {
                                updateFavorites('add', mode, id);
                                refreshFavorites('add', id);
                            } else {
                                msgAlert('You have reached maximum of 5 Favorite Series', 'good');
                            }
                        }
                        if (mode == 'venues') {
                            if (userJSON.myFavoriteLocations.length <= 4) {
                                updateFavorites('add', 'location', id);
                                refreshFavorites('add', id);
                            } else {
                                msgAlert('You have reached maximum of 5 Favorite Venues', 'good');
                            }
                        }
                        if (mode == 'collection') {
                            if (userJSON.myFavoriteLocations.length <= 4) {
                                updateFavorites('add', 'collection', id);
                                refreshFavorites('add', id);
                            } else {
                                msgAlert('You have reached maximum of 5 Favorite Collections', 'good');
                            }
                        }
                    }
                });
            });
        } else {
            showLoginPanel(buttons);
            buttons.attr('title', 'Login to use this feature').addClass('disable');
        }
        addTooltip('.lecture-page .lecture-add-to-fav', 'info');
    }
}

// Ajax create events for sidebars
var initAjaxAsideSidebar = function (el) {
    var items = $(el);
    if (items.length > 0) {
        items.each(function () {
            var item = $(this);
            var url = item.attr('data-href');

            ResponsiveHelper.addRange({
                '1024..': {
                    on: function (e) {
                        item.on('click', function (e) {
                            e.preventDefault();
                            sidebarDesktopClickHandler(item, url);
                            return false;
                        });
                    },
                    off: function () {
                        sidebarDesktopDestroy(item, url);
                    }
                }
            });
        });
    }
};

var sidebarDesktopClickHandler = function (item, url) {
    var body = $('body');
    body.removeClass('aside-active no-margin-body');
    showSidebar();
    /*currentPlayingShiurID = 0;*/
    currentPlayingShiur = true;
    // Slavisa: TODO put email notification on error
    ajaxLoadContent(url, 'json', false, function (data) { // Load JSON output
        setTimeout(function () {
            if (!$.isEmptyObject(data)) {
                if (isCalled == 0) {
                    if (data.teacherID) {
                        createTeacherSidebar(data);
                    } else if (data.subcategoryID) {
                        createCategorySidebar(data);
                    } else if (data.seriesID) {
                        createSeriesSidebar(data);
                    } else if (data.locationID) {
                        createVenuesSidebar(data);
                    } else if (data.collectionID) {
                        createCollectionSidebar(data);
                    }
                    isCalled = 1;
                }
            } else {
                msgAlert('Error loading content. Please try again.', 'error');
                $('.detail-box').fadeOut('fast');
            }
        }, 500);
        isCalled = 0;
    });
    body.addClass('aside-active no-margin-body');
    return false;
};

var sidebarDesktopDestroy = function (item, url) {
    var body = $('body');
    body.removeClass('aside-active no-margin-body');
    item.off('click', function () {
        sidebarDesktopClickHandler(item, url);
    });
    $('.detail-box').remove();
};

// create Recently Added and Top Lectures Tabs
function getRecentlyAddedAndTopLectures(data) {
    //tabs begin
    var tabs = $('<div class="tabs">');
    var tabsHead = '';
    tabsHead += '<div class="tab-head">';
    tabsHead += ' <ul class="tabset js-tabset">';
    tabsHead += '   <li><a href="#tab21" class="active">Recently Added</a></li>';
    tabsHead += '   <li><a href="#tab22">Top Lectures</a></li>';
    tabsHead += ' </ul>';
    tabsHead += '</div>';
    $(tabsHead).appendTo(tabs);

    var recently = $('<div id="tab21">');
    var recentlyUL = $(data.recentlyAddedLecturesHTMLSnippet);

    recentlyUL.appendTo(recently);
    var moreLink = $('<a href="' + data.searchURL + '" class="btn-more"><span>More</span></a>');
    moreLink.appendTo(recently);
    recently.appendTo(tabs);

    var topLectures = $('<div id="tab22">');
    var topLecturesUL = $(data.topLecturesHTMLSnippet);

    topLecturesUL.appendTo(topLectures);
    topLectures.appendTo(tabs);

    return tabs;
    //tabs end
}

// create Tickbox layout
function showThickBox(title, id, type, media) {
    var typeID;
    var subscribeTo;
    if (type == 'teacher') {
        typeID = 'teacherID';
        // subscribeTo = 'subscribeTeacher';
        subscribeTo = 'teachers';
    } else if (type == 'series') {
        typeID = 'seriesID';
        subscribeTo = 'series';
    } else if (type == 'category') {
        typeID = 'subcategoryID';
        subscribeTo = 'categories';
    } else if (type == 'locations') {
        typeID = 'locationID';
        subscribeTo = 'venues';
    }
    /*if(media == 'podcast'){
      if(type == 'teacher'){
        tb_show('Podcast', '/rss/itune.cfm?' + typeID + '='+ id +'&teacherInfo=' + title + '&sidebarCall=true&KeepThis=true&TB_iframe=true&height=120&width=220');
      } else {
        tb_show('Podcast', '/rss/itune.cfm?' + typeID + '='+ id + '&sidebarCall=true&KeepThis=true&TB_iframe=true&height=120&width=220');
      }
    } */
    if (media == 'podcast') {
        var url = 'itpc://' + _siteURL.replace('http://', '').replace('https://', '') + '/rss/RecentAudioShiurim?' + typeID + '=' + id + '&organizationID=301&numberOfRssResults=10';
        window.open(url, '_blank');
        $('#sidebarSubscribeLink').val(url);
        $('#get-sidebar-subscribe-link').removeClass('hide-element');
    }
    if (media == 'rss') {
        if (type == 'teacher') {
            tb_show('RSS', '/rss/rssfeed?' + typeID + '=' + id + '&teacherInfo=' + title + '&sidebarCall=true&KeepThis=true&TB_iframe=true&height=100&width=230');
        } else {
            tb_show('RSS', '/rss/rssfeed?' + typeID + '=' + id + '&sidebarCall=true&KeepThis=true&TB_iframe=true&height=100&width=230');
        }
    }
    if (media == 'email') {
        tb_show('Email Subscription', '/' + subscribeTo + '?' + typeID + '=' + id + '&sidebar=true&KeepThis=true&TB_iframe=false&height=135&width=350');
    }
}

function showEmailBox(title, id, type, media) {
    var url = '/Teachers?teacherId=' + id;

    $.magnificPopup.open({
        items: {
            src: url,
            type: 'ajax'
        },
        callbacks: {
            ajaxContentAdded: function () {
                $('#TB_closeWindowButton').on('click', function () {
                    $.magnificPopup.close();
                });
            }
        },
        fixedContentPos: true,
        overflowY: 'scroll',
        mainClass: 'login-popup',
        alignTop: false,
        closeOnBgClick: false,
        enableEscapeKey: true,
        showCloseBtn: false
    });
}

// create subscribe and share box for sidebar
function createSubscribeShare(name, id, type, landingPageURL = "") {
    var facebookUrl = "#"
    var twitterUrl = "#"
    var mailUrl = "#"
    if (landingPageURL != "") {
        var encodedFacebookUrl = encodeURIComponent(landingPageURL)
        facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodedFacebookUrl}&amp;src=sdkpreparse`
        twitterUrl = `https://twitter.com/intent/tweet?text=${'YUTorah - ' + name}&url=${landingPageURL}`;
        mailUrl = `mailto:?subject=${'YUTorah - ' + name}&body=${'YUTorah - ' + name}%20${landingPageURL}`;
    }
    var info = '';
    info += '<div class="share-bar sidebar-share">';
    info += '    <span>Share this:</span>';
    info += '    <ul>';
    info += '        <li class="facebook"><a href="' + facebookUrl + '" class="addthis_button_facebook at300b" title="Facebook" target="_blank"><span>Facebook</span></a></li>';
    info += '        <li class="twitter"><a href="' + twitterUrl + '" class="addthis_button_twitter at300b" title="Tweet" target="_blank"><span>Twitter</span></a></li>';
    // info += '        <li class="googleplus"><a href="#" class="addthis_button_google_plusone_share at300b" target="_blank" title="Google+"><span>Google+</span></a></li>';
    info += '        <li class="mail"><a href="' + mailUrl + '" class="addthis_button_email at300b" title="Mail"><span>Mail</span></a></li>';
    info += '    </ul>';
    info += '</div>';

    info += '<div class="sidebar-subscribe">';
    info += '    <span>Subscribe to:</span>';
    info += '    <ul class="info-links">';
    if (userAuthenticated == 1) {
        info += '        <li><a onclick="showThickBox(\'' + name + '\', \'' + id + '\', \'' + type + '\', \'podcast\'); return false;" href="#" class="info-podcast" title="Podcast"><span>Podcast</span></a></li>';
        info += '        <li><a onclick="showThickBox(\'' + name + '\', \'' + id + '\', \'' + type + '\', \'email\');" href="#" class="info-email thickbox" title="Email"><span>Email</span></a></li>';
        info += '        <li><a onclick="showThickBox(\'' + name + '\', \'' + id + '\', \'' + type + '\', \'rss\');" href="#" class="info-rss thickbox" title="RSS"><span>RSS</span></a></li>';
    } else {
        info += '        <li><a href="#" class="info-podcast" title="Login to use this feature"><span>Podcast</span></a></li>';
        info += '        <li><a href="#" class="info-email" title="Login to use this feature"><span>Email</span></a></li>';
        info += '        <li><a href="#" class="info-rss" title="Login to use this feature"><span>RSS</span></a></li>';
        setTimeout(function () {
            showLoginPanel('.detail-box .info-podcast, .detail-box .info-email, .detail-box .info-rss', 'info');
        }, 250);
    }
    info += '    </ul>';
    info += '    <div class="clear"></div>';
    info += '</div>';

    info += '<div class="hide-element" id="get-sidebar-subscribe-link" class="sidebar-subscribe-link">';
    info += '   <p>Subscribe link: </p>';
    info += '   <input type="text" id="sidebarSubscribeLink" name="sidebarSubscribeLink" value="" readonly />';
    info += '</div>';
    return info;
}

// create favorite button for sideabr
function favoritesButtonSidebar(type, typeID) {
    $('.detail-box').find('.add-to-favorites').on('click', function () {
        if ($(this).hasClass('active')) {
            $(this).removeClass('active');
            $(this).html('Add to favorites');
            $(this).attr('title', 'Add to Favorite');
            // call method and send ID, remove
            updateFavorites('remove', type, typeID);
            refreshFavorites('remove', typeID);
        } else {
            $(this).addClass('active');
            $(this).html('Remove from favorites');
            $(this).attr('title', 'Remove from Favorits');
            // call method and sendID, add
            updateFavorites('add', type, typeID);
            refreshFavorites('add', typeID);
        }
        return false;
    });
}

function createSidebarAd(parentElement) {
    //sidebar ad start
    ajaxLoadContent('https://yutorah.org/Home/GetSidebarBanners', 'json', false, function (adData) { // Load JSON output
        console.log(adData);
        if (adData != null && adData.sbFilename !== undefined) {
            var adDataHTML = '<div class="sidebar-ad" style="text-align:center;">';
            adDataHTML = adDataHTML + '<a href="' + adData.sbURL + '" target="' + (adData.sbIsNewWindow == 1 ? "_blank" : "") + '">';
            adDataHTML = adDataHTML + '<img src="https://cdnyutorah.cachefly.net/_files/adSideBanners/' + adData.sbFilename + '" alt="' + adData.sbTitle + '" /></a>';
            adDataHTML = adDataHTML + '</div>';
            $(adDataHTML).prependTo(parentElement);
        }
    });
    //sidebar ad end
}
// create Teacher sidebar content
function createTeacherSidebar(data) {

    console.log("Teacher Sidebar: ",data);

    var detailBox = $('<div class="detail-box-holder">');
    $('#loading-sidebar').remove();
    $('.detail-box').addClass('sidebar2');

    //////////////////////////////////////////////////////////////////////////
    // Browser History: Set the teacher sidebar URL as the browser address bar 
    if (!isBackForwardButton) {
        var pageTitle = data.teacherFullName;
        var pageURL = '/sidebar/teacher/' + data.teacherID + '/' + data.landingPageURL.replace(_siteURL + '/', '');
        //var pageURL = '/' + data.landingPageURL.replace(_siteURL + '/', '');
        stateChangedManually = true;
        if (!disableHistoryStateChange) {
            History.pushState({ state: 1, rand: Math.random() }, pageTitle, pageURL);
        }
    }
    isBackForwardButton = false;
    //////////////////////////////////////////////////////////////////////////



    //person info start
    var personInfo = $('<div class="person-info">');
    var personHead = $('<div class="person-head">');


    createSidebarAd(personInfo);

    var alignLeft = $('<div class="alignleft"><a href="' + data.landingPageURL + '"><img src="' + data.teacherPhotoURL_lp + '" alt="' + data.teacherFullName + '" ></a></div>')
    alignLeft.appendTo(personHead);

    var favoriteClass = '';
    var favoriteLabel = 'Add to favorites';
    var favoriteTitle = 'Add to Favorites';
    var info = '';
    info += '<div class="info">';
    info += '<h3 class="title">' + data.teacherFullName + '</h3>';
    info += '<div><a class="info-readmore" href="' + data.landingPageURL + '">Go to full page</a></div>';

    var inArrayFlag = false;
    if (userAuthenticated == 1) {
        if (!$.isEmptyObject(userJSON.myFavoriteTeachers)) {
            $.each(userJSON.myFavoriteTeachers, function (i) {
                if (userJSON.myFavoriteTeachers[i].teacherID == data.teacherID) {
                    inArrayFlag = true;
                }
            });
        }
    } else {
        favoriteClass = ' disable';
        favoriteTitle = 'Login to use this feature';
    }

    info += '<div><a href="#" data-id="' + data.teacherID + '" class="add-to-favorites' + favoriteClass + '" title="' + favoriteTitle + '">' + favoriteLabel + '</a></div>';
    info += createSubscribeShare(data.teacherFullName, data.teacherID, 'teacher', data.landingPageURL);
    info += '</div>';

    $(info).appendTo(personHead);

    personHead.appendTo(personInfo);
    if (data.teacherBio !== '') {
        var details = '';
        details += '<div class="detail">';
        details += data.teacherBio;
        details += '</div>';
        $(details).appendTo(personInfo);
    }

    if (data.teacherBio.length > 60) {
        var more = $('<a href="#" class="more-info"><span class="static">More Info</span><span class="active">Less info</span></a>');
        more.appendTo(personInfo);
    }
    personInfo.appendTo(detailBox);
    //person info end

    if (data.sponsorTeacher != null && data.sponsorTeacher.length > 0) {
        data.sponsorTeacher.forEach(function (sponsor) {
            $(detailBox).append(
                $('<div>', {
                    class: 'sponsor-message',
                    text: data.teacherFullName + "'s shiurim today have been sponsored by " +
                        sponsor.sponsorName + " " +
                        sponsor.sponsorPrefix + " " +
                        sponsor.sponsorMessage
                })
            );
        });
    } else {
        //$(detailBox).append(
        //    $('<div>', {
        //        class: 'sponsor-message'
        //    }).append(
        //        $('<a>', {
        //            href: 'https://www.givecampus.com/campaigns/50770/donations/new',
        //            target: '_blank',
        //            text: "Click here to sponsor " + data.teacherFullName + "'s shiurim",
        //            style: "color: white;"
        //        })
        //    )
        //);
    }


    getRecentlyAddedAndTopLectures(data).appendTo(detailBox);

    //append content to sidebar
    if (detailBox.length) {
        window.picturefill();
        detailBox.hide().appendTo('.detail-box').fadeIn(500);
        detailBox.find('.js-tabset').contentTabs({
            tabLinks: 'a'
        });
        detailBox.css({
            right: ''
        });
    }

    $(detailBox).find('.more-info').on('click', function () {
        if ($(detailBox).find('.detail').hasClass('active')) {
            $(detailBox).find('.detail').removeClass('active');
            $(this).find('.active').hide();
            $(this).find('.static').show();
        } else {
            $(detailBox).find('.detail').addClass('active');
            $(this).find('.static').hide();
            $(this).find('.active').show();
        }
        return false;
    });

    $(detailBox).find('#sidebarSubscribeLink').on('click', function () {
        $(this).select();
    });

    if (userAuthenticated == 1) {
        if (userJSON.myFavoriteTeachers.length <= 4 || (userJSON.myFavoriteTeachers.length == 5 && inArrayFlag === true)) {
            favoritesButtonSidebar('teacher', data.teacherID);
        } else {
            detailBox.find('.add-to-favorites').addClass('disable').on('click', function () { msgAlert('You have reached maximum of 5 Favorite Teachers', 'good'); });
        }
        if (inArrayFlag === true) {
            detailBox.find('.add-to-favorites').attr('title', 'Remove from Favorite').removeClass('disable').addClass('active').html('Remove from favorites');
        }
    } else {
        showLoginPanel(detailBox.find('.add-to-favorites'));
    }

    // Add tooltip
    addTooltip('.detail-box .add-to-favorites', 'info');

    //featured buttons for each item
    initFeaturedButtons('.detail-box .post');
    editShiur('.detail-box .tabs');

    loadAddThis('.sidebar-share', data.landingPageURL);
    addTooltip('.sidebar-share a', 'info');
    addTooltip('.sidebar-subscribe a', 'info');
    addTooltip(detailBox.find('.post-uploaded').attr('title', 'Uploaded Date'), 'info', 'center', 'right', 'center', 'left');

    //slideshow for multiple teachers
    imgSlideShow(detailBox.find('.img-holder'));

    // Notify Google Analytics
    notifyGoogleAnalytics('Teacher', 'Sidebar', data.teacherFullName, data.teacherID, data.landingPageURL);
}

// create Category sidebar content
function createCategorySidebar(data) {
    var detailBox = $('<div class="detail-box-holder">');
    $('#loading-sidebar').remove();
    $('.detail-box').addClass('sidebar2');

    //////////////////////////////////////////////////////////////////////////
    // Browser History: Set the category sidebar URL as the browser address bar 
    if (!isBackForwardButton) {
        var pageTitle = data.title;
        var pageURL = '/sidebar/category/' + data.subcategoryID + '/' + data.landingPageURL.replace(_siteURL + '/', '');
        //var pageURL = '/' + data.landingPageURL.replace(_siteURL + '/', '');
        stateChangedManually = true;
        if (!disableHistoryStateChange) {
            History.pushState({ state: 1, rand: Math.random() }, pageTitle, pageURL);
        }
    }
    isBackForwardButton = false;
    //////////////////////////////////////////////////////////////////////////

    //person info start
    var personInfo = $('<div class="person-info">');
    var personHead = $('<div class="person-head">');

    createSidebarAd(personInfo);

    var alignLeft = $('<div class="alignleft"><a href="' + data.landingPageURL + '"><img src="' + data.subcategoryPhotoURL + '" alt="' + data.title + '" ></a></div>')
    alignLeft.appendTo(personHead);

    var info = '';
    info += '<div class="info">';
    info += '<h3 class="title">' + data.title + '</h3>';
    info += '<div><a class="info-readmore" href="' + data.landingPageURL + '">Go to full page</a></div>';
    info += createSubscribeShare(data.title, data.subcategoryID, 'category', data.landingPageURL);
    info += '</div>';

    $(info).appendTo(personHead);

    personHead.appendTo(personInfo);

    personInfo.appendTo(detailBox);
    //person info end

    getRecentlyAddedAndTopLectures(data).appendTo(detailBox);

    //append content to sidebar
    if (detailBox.length) {
        window.picturefill();
        detailBox.hide().appendTo('.detail-box').fadeIn(500);
        detailBox.find('.js-tabset').contentTabs({
            tabLinks: 'a'
        });
        detailBox.css({
            right: ''
        });
    }

    $(detailBox).find('#sidebarSubscribeLink').on('click', function () {
        $(this).select();
    });

    //featured buttons for each item
    initFeaturedButtons('.detail-box .post');
    editShiur('.detail-box .tabs');

    loadAddThis('.sidebar-share', data.landingPageURL);
    addTooltip('.sidebar-share a', 'info');
    addTooltip('.sidebar-subscribe a', 'info');
    addTooltip(detailBox.find('.post-uploaded').attr('title', 'Uploaded Date'), 'info', 'center', 'right', 'center', 'left');

    //slideshow for multiple teachers
    imgSlideShow(detailBox.find('.img-holder'));

    // Notify Google Analytics
    notifyGoogleAnalytics('Category', 'Sidebar', data.title, data.subcategoryID, data.landingPageURL);
}

// create Series sidebar content
function createSeriesSidebar(data) {
    var detailBox = $('<div class="detail-box-holder">');
    $('#loading-sidebar').remove();
    $('.detail-box').addClass('sidebar2');

    //////////////////////////////////////////////////////////////////////////
    // Browser History: Set the series sidebar URL as the browser address bar 
    if (!isBackForwardButton) {
        var pageTitle = data.title;
        var pageURL = '/sidebar/series/' + data.seriesID + '/' + data.landingPageURL.replace(_siteURL + '/', '');
        //var pageURL = '/' + data.landingPageURL.replace(_siteURL + '/', '');
        stateChangedManually = true;
        if (!disableHistoryStateChange) {
            History.pushState({ state: 1, rand: Math.random() }, pageTitle, pageURL);
        }
    }
    isBackForwardButton = false;
    //////////////////////////////////////////////////////////////////////////

    //person info start
    var personInfo = $('<div class="person-info">');
    var personHead = $('<div class="person-head">');

    createSidebarAd(personInfo);

    var alignLeft = $('<div class="alignleft"><a href="' + data.landingPageURL + '"><img src="' + data.seriesPhotoURL + '" alt="' + data.title + '" ></a></div>')
    alignLeft.appendTo(personHead);

    var favoriteClass = '';
    var favoriteLabel = 'Add to favorites';
    var favoriteTitle = 'Add to Favorites';
    var info = '';
    info += '<div class="info">';
    info += '<h3 class="title">' + data.title + '</h3>';
    info += '<div><a class="info-readmore" href="' + data.landingPageURL + '">Go to full page</a></div>';

    var inArrayFlag = false;
    if (userAuthenticated == 1) {
        if (!$.isEmptyObject(userJSON.myFavoriteSeries)) {
            $.each(userJSON.myFavoriteSeries, function (i) {
                if (userJSON.myFavoriteSeries[i].seriesID == data.seriesID) {
                    inArrayFlag = true;
                }
            });
        }
    } else {
        favoriteClass = ' disable';
        favoriteTitle = 'Login to use this feature';
    }

    info += '<div><a href="#" data-id="' + data.seriesID + '" class="add-to-favorites' + favoriteClass + '" title="' + favoriteTitle + '">' + favoriteLabel + '</a></div>';
    info += createSubscribeShare(data.title, data.seriesID, 'series', data.landingPageURL);
    info += '</div>';

    $(info).appendTo(personHead);

    personHead.appendTo(personInfo);

    if (data.seriesDescription !== '') {
        var details = $('<div class="detail detail-series">' + data.seriesDescription + '</div>');
        details.appendTo(personInfo);
    }

    personInfo.appendTo(detailBox);
    //person info end

    getRecentlyAddedAndTopLectures(data).appendTo(detailBox);

    //append content to sidebar
    if (detailBox.length) {
        window.picturefill();
        //$('.detail-box').fadeOut(500, function(){$(this).remove()});
        detailBox.hide().appendTo('.detail-box').fadeIn(500);
        detailBox.find('.js-tabset').contentTabs({
            tabLinks: 'a'
        });
        detailBox.css({
            right: ''
        });
    }

    $(detailBox).find('#sidebarSubscribeLink').on('click', function () {
        $(this).select();
    });

    if (userAuthenticated == 1) {
        if (userJSON.myFavoriteSeries.length <= 4 || (userJSON.myFavoriteSeries.length == 5 && inArrayFlag === true)) {
            favoritesButtonSidebar('series', data.seriesID);
        } else {
            detailBox.find('.add-to-favorites').addClass('disable').on('click', function () { msgAlert('You have reached maximum of 5 Favorite Series', 'good'); });
        }
        if (inArrayFlag === true) {
            detailBox.find('.add-to-favorites').attr('title', 'Remove from Favorites').removeClass('disable').addClass('active').html('Remove from favorites');
        }
    } else {
        showLoginPanel(detailBox.find('.add-to-favorites'));
    }

    // Add tooltip
    addTooltip('.detail-box .add-to-favorites', 'info');

    //featured buttons for each item
    initFeaturedButtons('.detail-box .post');
    editShiur('.detail-box .tabs');

    loadAddThis('.sidebar-share', data.landingPageURL);
    addTooltip('.sidebar-share a', 'info');
    addTooltip('.sidebar-subscribe a', 'info');
    addTooltip(detailBox.find('.post-uploaded').attr('title', 'Uploaded Date'), 'info', 'center', 'right', 'center', 'left');

    //slideshow for multiple teachers
    imgSlideShow(detailBox.find('.img-holder'));

    // Notify Google Analytics
    notifyGoogleAnalytics('Series', 'Sidebar', data.title, data.seriesID, data.landingPageURL);
}

// create Venues sidebar content
function createVenuesSidebar(data) {
    var detailBox = $('<div class="detail-box-holder">');
    $('#loading-sidebar').remove();
    $('.detail-box').addClass('sidebar2');

    //////////////////////////////////////////////////////////////////////////
    // Browser History: Set the location sidebar URL as the browser address bar 
    if (!isBackForwardButton) {
        var pageTitle = data.title;
        var pageURL = '/sidebar/location/' + data.locationID + '/' + data.landingPageURL.replace(_siteURL + '/', '');
        //var pageURL = '/' + data.landingPageURL.replace(_siteURL + '/', '');
        stateChangedManually = true;
        if (!disableHistoryStateChange) {
            History.pushState({ state: 1, rand: Math.random() }, pageTitle, pageURL);
        }
    }
    isBackForwardButton = false;
    //////////////////////////////////////////////////////////////////////////

    //person info start
    var personInfo = $('<div class="person-info">');
    var personHead = $('<div class="person-head">');

    createSidebarAd(personInfo);

    var alignLeft = $('<div class="alignleft"><a href="' + data.landingPageURL + '"><img src="' + data.locationPhotoURL + '" alt="' + data.title + '" ></a></div>')
    alignLeft.appendTo(personHead);

    var favoriteClass = '';
    var favoriteLabel = 'Add to favorites';
    var favoriteTitle = 'Add to Favorites';
    var info = '';
    info += '<div class="info">';
    info += '<h3 class="title">' + data.title + '</h3>';
    info += '<div><a class="info-readmore" href="' + data.landingPageURL + '">Go to full page</a></div>';

    var inArrayFlag = false;
    if (userAuthenticated == 1) {
        if (!$.isEmptyObject(userJSON.myFavoriteLocations)) {
            $.each(userJSON.myFavoriteLocations, function (i) {
                if (userJSON.myFavoriteLocations[i].locationID == data.locationID) {
                    inArrayFlag = true;
                }
            });
        }
    } else {
        favoriteClass = ' disable';
        favoriteTitle = 'Login to use this feature';
    }

    info += '<div><a href="#" data-id="' + data.locationID + '" class="add-to-favorites' + favoriteClass + '" title="' + favoriteTitle + '">' + favoriteLabel + '</a></div>';
    info += createSubscribeShare(data.title, data.locationID, 'locations', data.landingPageURL);
    info += '</div>';

    $(info).appendTo(personHead);

    personHead.appendTo(personInfo);

    if (data.locationDescription !== '') {
        var details = $('<div class="detail detail-series">' + data.locationDescription + '</div>');
        details.appendTo(personInfo);
    }

    personInfo.appendTo(detailBox);
    //person info end

    getRecentlyAddedAndTopLectures(data).appendTo(detailBox);

    //append content to sidebar
    if (detailBox.length) {
        window.picturefill();
        detailBox.hide().appendTo('.detail-box').fadeIn(500);
        detailBox.find('.js-tabset').contentTabs({
            tabLinks: 'a'
        });
        detailBox.css({
            right: ''
        });
    }

    $(detailBox).find('#sidebarSubscribeLink').on('click', function () {
        $(this).select();
    });

    if (userAuthenticated == 1) {
        if (userJSON.myFavoriteLocations.length <= 4 || (userJSON.myFavoriteLocations.length == 5 && inArrayFlag === true)) {
            favoritesButtonSidebar('location', data.locationID);
        } else {
            detailBox.find('.add-to-favorites').addClass('disable').on('click', function () { msgAlert('You have reached maximum of 5 Favorite Venues', 'good'); });
        }
        if (inArrayFlag === true) {
            detailBox.find('.add-to-favorites').attr('title', 'Remove from Favorites').removeClass('disable').addClass('active').html('Remove from favorites');
        }
    } else {
        showLoginPanel(detailBox.find('.add-to-favorites'));
    }

    // Add tooltip
    addTooltip('.detail-box .add-to-favorites', 'info');

    //featured buttons for each item
    initFeaturedButtons('.detail-box .post');
    editShiur('.detail-box .tabs');

    loadAddThis('.sidebar-share', data.landingPageURL);
    addTooltip('.sidebar-share a', 'info');
    addTooltip('.sidebar-subscribe a', 'info');
    addTooltip(detailBox.find('.post-uploaded').attr('title', 'Uploaded Date'), 'info', 'center', 'right', 'center', 'left');

    //slideshow for multiple teachers
    imgSlideShow(detailBox.find('.img-holder'));

    // Notify Google Analytics
    notifyGoogleAnalytics('Venue', 'Sidebar', data.title, data.locationID, data.landingPageURL);
}

// create Collection sidebar content
function createCollectionSidebar(data) {
    $('.detail-box').addClass('collection-sidebar');
    var detailBox = $('<div class="detail-box-holder">');
    $('#loading-sidebar').remove();
    $('.detail-box').addClass('sidebar2');

    //person info start
    var personInfo = $('<div class="person-info">');
    var personHead = $('<div class="person-head">');

    createSidebarAd(personInfo);

    var collectionTitle = $('<div class="info"><h3 class="title">' + data.collectionTitle + '</h3></div>');
    collectionTitle.appendTo(personHead);

    personHead.appendTo(personInfo);
    personInfo.appendTo(detailBox);
    //person info end

    //collection items
    var tabs = $('<div class="tabs"></div>');
    var tabContent = $('<div class="tab-body"></div>');

    // ABOUT: Landing Pages > Collection Tab > Collection in Sidebar 
    $.each(data.collectionShiurim, function () {
        var post = $('<div class="post">');
        var alignLeft = $('<div class="alignleft">');
        $(alignLeft).appendTo(post);
        var imgHolder = $('<div class="img-holder">');
        $(imgHolder).appendTo(alignLeft);
        $.each(this.shiurTeachers, function () {
            var img = $('<img src="' + this.teacherPhotoURL + '" alt="' + this.teacherName + '">');
            $(img).appendTo(imgHolder);
        });
        //var played = $('<a href="#" class="btn-new">NEW</a>');
        //$(played).appendTo(alignLeft);
        var textbox = $('<div class="textbox">');
        $(textbox).appendTo(post);
        var title = $('<strong class="title"><a class="shiur" href="' + this.shiurHref + '" data-href="' + this.shiurDataHref + '" data-id="' + this.shiurID + '" data-type="' + this.mediaTypeCategory + '">' + this.shiurTitle + '</a></strong>');
        $(title).appendTo(textbox);
        var ulSub = $('<ul>');
        $(ulSub).appendTo(textbox);

        if (this.shiurTeachers.length > 0) {
            var speaker_container = '';
            if (this.shiurTeachers.length <= 1) {
                speaker_container += '<a class="teacher" href="' + this.shiurTeachers[0].landingPageURL + '" data-href="/teachers/sidebar/' + this.shiurTeachers[0].teacherID + '"><span class="speaker-name">' + this.shiurTeachers[0].teacherName + '</span></a>';
            } else {
                $.each(this.shiurTeachers, function () {
                    speaker_container += '<a class="teacher" href="' + this.landingPageURL + '" data-href="/teachers/sidebar/' + this.teacherID + '"><span class="speaker-name">' + this.teacherName + '</span></a>&nbsp, ';
                });
            }
            var speaker = $('<li class="speaker-li"><span class="speaker-icon">Speaker:</span>' + speaker_container + '</li>');
            $(speaker).appendTo(ulSub);
        }

        var date = $('<li class="date-li"><span>Date:</span> <time datetime="' + this.shiurDateSubmittedFormatted + '">' + this.shiurDateSubmittedText + '</time></li>');
        $(date).appendTo(ulSub);
        if (this.shiurDuration != '') {
            var duration = $('<li class="duration-li"><span>Duration:</span> ' + this.shiurDuration + '</li>');
        }
        $(duration).appendTo(ulSub);

        if (this.shiurDateSubmittedText2 != '') {
            var dateTime = $('<li class="post-uploaded"><span>' + this.shiurDateSubmittedText2 + '</span></li>');
            $(dateTime).appendTo(ulSub);
        }

        var buttons = '<div class="slide-box">';
        buttons += '<ul class="add">';
        if (userAuthenticated == 1) {
            if (this.shiurCanBeDownloaded == 1 && this.downloadURL != '') {
                buttons += '  <li class="download"><a href="' + this.downloadURL + '" title="Download this shiur">Download</a></li>';
            } /*else { hide if downloadURL == ""
        buttons += '  <li class="download"><a href="#" title="This shiur cannot be downloaded">Download</a></li>';
      }*/
        } else {
            buttons += '  <li class="download disable"><a href="#" title="Login to use this feature">Download</a></li>';
        }
        if (this.mediaTypeCategory == 'text') {
            buttons += '  <li class="queue"><a href="#" title="Add to articles list">Read Later</a></li>';
        } else {
            buttons += '  <li class="queue"><a href="#" title="Add to queue list">Play Later</a></li>';
            buttons += '  <li class="play"><a class="shiur" href="' + this.shiurHref + '" data-href="' + this.shiurDataHref + '" data-id="' + this.shiurID + '" data-type="' + this.mediaTypeCategory + '" title="Play this shiur">Play now</a></li>';
        }
        buttons += '</ul>';
        buttons += '</div>';
        $(buttons).appendTo(post);

        $(post).appendTo(tabContent);
    });
    tabContent.appendTo(tabs);
    tabs.appendTo(detailBox);

    /*var moreBtn = $('<a href="' + data.collectionURL + '" class="btn-more"><span>More</span></a>');
    moreBtn.appendTo(tabs);*/

    //append content to sidebar
    if (detailBox.length) {
        window.picturefill();
        detailBox.hide().appendTo('.detail-box').fadeIn(500);

        detailBox.css({
            right: ''
        });
    }
    //featured buttons for each item
    initFeaturedButtons('.detail-box .post');

    //slideshow for multiple teachers
    imgSlideShow(detailBox.find('.img-holder'));

    // Notify Google Analytics
    notifyGoogleAnalytics('Collection', 'Sidebar', data.collectionTitle, data.collectionID, data.collectionURL);
}

//open/close block items in queue section
function initOpenCloseQueueBlock(el) {
    var isTouchDevice = (/MSIE 10.*Touch/.test(navigator.userAgent)) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch,
        isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent)
    var event = isTouchDevice ? (isWinPhoneDevice ? 'click' : 'touchend') : 'click';

    $(el + ' .block').openClose({
        activeClass: 'active',
        hideOnClickOutside: true,
        opener: '.textbox, .status-bar',
        slider: '.detail',
        animSpeed: 400,
        event: event,
        customFlag: true,
        effect: 'slide'
        /*animStart: function(){
         $('.sidenav li.articles').data('ContentPopup').hidePopup();
       }*/
    });
}

//load Queue/Articles/History on button click and Clear All
function initQueue() {
    var queueButtons = $('.sidenav > ul > li > a');
    queueButtons.each(function () {
        var item = $(this);
        item.bind('click', function () {
            // Show always first item as active
            if (item.parent().hasClass('queue')) {
                $('.sidenav .queue .head > ul.tabset > li > a').removeClass('active');
                $('.sidenav .queue .head > ul.tabset > li:first-child > a').addClass('active');
                $('.sidenav .queue .side-tabs .tab-content .tab-content-inner').hide();
                $('.sidenav .queue .side-tabs .tab-content #tab2').show();
                $('.sidenav > ul > li.queue .download-bar > a').show();
            }
            if (item.parent().hasClass('queue') && callQueue == false) {
                callQueue = true;
                if ((isPlayed == 1)) {
                    sendIsPlayedData('add');
                    item.parent().find('.queue-panel').addClass('loading');
                    setTimeout(function () {
                        refreshQueue('get', 000000, 'queue', 0, '');
                    }, 500);
                    callQueue == false;
                }
            } else if (item.parent().hasClass('articles') && callArticles == false) {
                /*callArticles = true;*/
                item.parent().find('.queue-panel').addClass('loading');
                setTimeout(function () {
                    refreshQueue('get', 000000, 'articles', 0, '');
                }, 500);
            }
        });
    });
    var queueTabs = $('.sidenav .queue .head > ul.tabset > li > a');
    queueTabs.each(function () {
        var item = $(this);
        var itemHref = item.attr('href');
        item.bind('click', function () {
            $('.sidenav .head > ul.tabset > li > a').removeClass('active');
            item.addClass('active');
            $('.sidenav .queue .side-tabs .tab-content .tab-content-inner').hide();
            $('.sidenav .queue .tab-content ' + itemHref).show();
            $('.sidenav .queue .tab-content .noresults').hide();

            if (item.parent().hasClass('history-tab')) {
                $('#queue-form').addClass('hide-element');
                $('#history-form').removeClass('hide-element');
                $('.sidenav > ul > li.queue .download-bar > a').hide();
                if (callHistory == false) {
                    callHistory = true;
                    $('.sidenav > ul > li.queue .queue-panel').addClass('loading');
                    setTimeout(function () {
                        refreshQueue('get', 000000, 'history', 0, '');
                    }, 500);
                }
            } else {
                $('.sidenav > ul > li.queue .download-bar > a').show();
                $('#queue-form').removeClass('hide-element');
                $('#history-form').addClass('hide-element');
            }
            return false;
        });
    });

    var clearAllQueue = $('#clearAllQueue');
    var queueListItems = '';
    clearAllQueue.on('click', function () {
        if (!$.isEmptyObject(queueList)) {
            if (confirm('Are you sure you want to clear ALL items from MY SHIURIM?')) {
                $.each($('.sidenav > ul > li.queue .queue-content .block'), function () {
                    queueListItems += $(this).attr('data-id');
                    queueListItems += 'Ãœ';
                });
                $('.sidenav > ul > li.queue .queue-content .block').remove();
                queueListItems = queueListItems.slice(0, -1);
                refreshQueue('remove', queueListItems, 'queue', 0, '');
                queueListItems = '';
                queueList = [];
                callHistory = false;
                destroyPlayerFromQueue(playingShiurID);
                $('.sidenav .player-info p').show();
            }
        } else {
            msgAlert('Your Queue list is already empty', 'good');
        }
        return false;
    });

    var clearAllArticles = $('#clearAllArticles');
    var articlesListItems = '';
    clearAllArticles.on('click', function () {
        if (!$.isEmptyObject(articlesList)) {
            if (confirm('Are you sure you want to clear all items from Articles?')) {
                $.each($('.sidenav > ul > li.articles .block'), function () {
                    articlesListItems += $(this).attr('data-id');
                    articlesListItems += 'Ãœ';
                });
                $('.sidenav > ul > li.articles .block').remove();
                articlesListItems = articlesListItems.slice(0, -1);
                refreshQueue('remove', articlesListItems, 'articles', 0, '');
                articlesListItems = '';
                articlesList = [];
                callHistory = false;
            }
        } else {
            msgAlert('Your Articles list is already empty', 'good');
        }
        return false;
    });
}

// main function for Queue get/add/remove/update
var refreshQueue = function (action, shiurID, bookmarkType, sortIndex, historySearchTerm) {
    if (shiurID != 'undefined') {
        var params = {
            'action': action,
            'shiurID': shiurID,
            'bookmarkType': bookmarkType,
            'sortIndex': sortIndex,
            'historySearchTerm': historySearchTerm
        };
        // Slavisa: TODO put email notification on error
        $.ajax({
            url: '/Queue/queue',//'/js/queue.json', //url: '/queue/queue.cfm',
            cache: false,
            type: 'get',
            //type: 'post',
            data: params,
            dataType: 'json',
            async: true,
            success: function (data) {
                if ($.isEmptyObject(data.data) && data.isError == true) {
                    msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
                }
                if (data.data.length == 0 && data.isError == false && bookmarkType == 'history') {
                    $('.sidenav .queue .tab-content .noresults').show();
                }
                if ((!$.isEmptyObject(data))/*&& data.errorMessage !== 'Shiur already added to the queue.'*/) {
                    if (bookmarkType == 'queue' && action == 'get') {
                        refreshQueueContent(data.data, bookmarkType);
                        queueList = [];
                        $.each(data.data.shiurQueue, function (i) {
                            queueList.push(parseInt(this.shiurID));
                        });
                    } else if (bookmarkType == 'articles' && action == 'get') {
                        refreshQueueContent(data.data, bookmarkType);
                        articlesList = [];
                        $.each(data.data, function (i) {
                            articlesList.push(parseInt(this.shiurID));
                        });
                        callArticles = true;
                    } else if (bookmarkType == 'history' && action == 'get') {
                        refreshQueueContent(data.data, bookmarkType);
                    }
                }
                if (data.errorMessage === '' && shiurID !== 000000 && action === 'add') {
                    if (bookmarkType == 'queue') {
                        myShiurimAddEffect('queue');
                    } else if (bookmarkType == 'articles') {
                        myShiurimAddEffect('articles');
                    }
                }
                if (data.errorMessage !== '') {
                    if (data.isError) {
                        msgAlert(data.errorMessage, 'error');
                    } else {
                        msgAlert(data.errorMessage, 'good');
                    }
                }
                if (action == 'add' /*|| action == 'remove'*/) {
                    refreshQueue('get', 000000, bookmarkType, 0, '');
                }

                // refresh number of queue items in each tab
                if (action == 'remove' && bookmarkType == 'queue') {
                    countQueueItems();
                }

                // set queue GUI flag
                if (action == 'get' && bookmarkType == 'queue') {
                    queueGet = 1;
                } else {
                    queueGet = 0;
                }
            },
            error: function (jqXHR, exception) {
                ajaxErrorHandler(jqXHR, exception);
            }
        });
    }
};

// refresh queue numbers
function refreshQueueNumbers(type) {
    if (type == 'queue') {
        var blockTab1 = $('.sidenav ul li.queue #tab1 .block');
        var blockTab2 = $('.sidenav ul li.queue #tab2 .block');
        var blockTab3 = $('.sidenav ul li.queue #tab3 .block');
        blockTab1.each(function (i) {
            $(this).attr('data-index', (i + 1));
            $(this).find('.counter-holder span').html((i + 1));
        });
        blockTab2.each(function (i) {
            $(this).attr('data-index', (i + 1));
            $(this).find('.counter-holder span').html((i + 1));
        });
        blockTab3.each(function (i) {
            $(this).attr('data-index', (i + 1));
            $(this).find('.counter-holder span').html((i + 1));
        });
    }
    if (type == 'articles') {
        var block = $('.sidenav ul li.articles .tab-content-inner .block');
        block.each(function (i) {
            $(this).attr('data-index', (i + 1));
            $(this).find('.counter-holder span').html((i + 1));
        });
    }
}

//add to queue effect
function myShiurimAddEffect(type) {
    var text,
        box,
        element;
    if (type == 'queue') {
        text = '<div class="added-to-queue">Added to My Shiurim</div>';
        box = $('.sidenav > ul > li.queue > a');
        element = $('.added-to-queue');
    } else {
        text = '<div class="added-to-article">Added to Articles</div>';
        box = $('.sidenav > ul > li.articles > a');
        element = $('.added-to-article');
    }
    if (element.length <= 0) {
        $(text).fadeIn('slow').prependTo(box).delay(2000).fadeOut('slow', function () {
            $(this).remove();
        });
    }
}

//main add/remove/get/update to queue/articles/history function
function buttonsQueueHistory(buttonsQueueItems, bookmarkType) {
    buttonsQueueItems.each(function () {
        var block = $(this);
        var shiurID = block.find('.title a').attr('data-shiurid');
        var linkAddToQueueParent = block.find('.add li.queue');
        var linkAddToQueue = block.find('.add li.queue a');
        if (linkAddToQueueParent.hasClass('article')) {
            linkAddToQueue.on('click', function () {
                refreshQueue('add', shiurID, 'articles', 0, '');
            });
        } else {
            linkAddToQueue.on('click', function () {
                refreshQueue('add', shiurID, 'queue', 0, '');
            });
        }
    });
}

function buttonsQueue(buttonsQueueItems, bookmarkType) {
    buttonsQueueItems.each(function () {
        var block = $(this);
        var shiurID = block.find('.title a').attr('data-shiurid');
        var linkRemove = block.find('a.remove');
        var linkDownload = block.find('.add li.download a');

        if (bookmarkType == 'queue') {
            linkRemove.on('click', function () {
                linkRemove.qtip('destroy', true);
                block.fadeOut(200, function () { block.remove(); });
                $('.sidenav ul li.queue .block[data-id="' + $(this).attr('data-remove-id') + '"]').remove();
                setTimeout(function () {
                    refreshQueueNumbers('queue');
                }, 250);
                refreshQueue('remove', shiurID, 'queue', 0, '');
                callHistory = false;
                callQueue = false;
                destroyPlayerFromQueue(shiurID);
                return false;
            });
        } else if (bookmarkType == 'articles') {
            linkRemove.on('click', function () {
                linkRemove.qtip('destroy', true);
                block.fadeOut(200, function () { block.remove(); });
                setTimeout(function () {
                    refreshQueueNumbers('articles');
                }, 250);
                refreshQueue('remove', shiurID, 'articles', 0, '');
                callHistory = false;
                //callArticles = false;
                return false;
            });
        }

        linkDownload.on('click', function () {
            if (linkDownload.attr('href') != '#') {
                urchin_logDownload(shiurID, '', '0');
            }
        });
    });
}

//show number of queue items in each tab
function countQueueItems() {
    var queueCountInProgress = 0;
    var queueCountUpcoming = 0;
    var queueTotal = 0;
    queueCountInProgress = $('.sidenav .queue .tab-content #tab2 .block').length;
    queueCountUpcoming = $('.sidenav .queue .tab-content #tab1 .block').length;
    queueTotal = queueCountUpcoming + queueCountInProgress;
    $('#queue-inprogress-num').html('(' + queueCountInProgress + ')');
    $('#queue-upcoming-num').html('(' + queueCountUpcoming + ')');
    $('#queue-num').html('(' + queueTotal + ')');

    if (queueTotal >= 200 && $(".welcome-msg>strong").text().length >= 1 && $.cookie("my_shiurim") != "done") {
        msgAlert($(".welcome-msg>strong").text() + ", it looks like you a lot of items in your queue. Too many items can adversely affect the performance of yutorah.org. Please consider removing some of the items from your queue.", "error");
        $.cookie("my_shiurim", "done");
    } else if ($(".welcome-msg>strong").text().length <= 1) {
        $.removeCookie("my_shiurim");
    }
}

// TODO: Optimization
function refreshQueueContent(data, bookmarkType) {
    var body = $('body');
    var historyTab;
    if (bookmarkType == 'queue') {
        var queueTabUpcoming = body.find('.sidenav li.queue .tab-content #tab1').html('');
        var queueTabInProgress = body.find('.sidenav li.queue .tab-content #tab2').html('');
        //var queueTabListened = body.find('.sidenav li.queue .tab-content #tab3').html('');
        var counterListened = 1;
        var counterNotListened = 1;
    } else if (bookmarkType == 'articles') {
        var articleTab = body.find('.sidenav li.articles .tab-content .tab-content-inner').html('');
    } else if (bookmarkType == 'history') {
        var historyTab = body.find('.sidenav li.queue .tab-content #tab3').html('');
    }

    // Join shiurQueue (bookmark rows) to shiurim (shiur details) by shiurID.
    // Previously these were paired by array index, which silently corrupted
    // rendering whenever the two lists came back in different orders.
    var shiurimByID = {};
    $.each(data.shiurim, function (idx, s) {
        shiurimByID[s.shiurID] = s;
    });

    $.each(data.shiurQueue, function (i, queueItem) {
        var shiur = shiurimByID[queueItem.shiurID];
        if (!shiur) return; // shiur details missing for this queue row - skip it

        //begin making html for queue block
        var container = '';

        var activeClass = '';
        if (shiur.shiurID == playingShiurID && playerGetStatus() == false) {
            activeClass = ' active-playing';
        }

        if (queueItem.usbBookmarkType == 'queue') {
            container += '<div class="block' + activeClass + '" data-index="' + (i + 1) + '" data-id="' + shiur.shiurID + '">';
        } else {
            container += '<div class="block" data-index="' + (i + 1) + '" data-id="' + shiur.shiurID + '">';
        }
        container += '<div class="slide-box"><ul class="add">';
        if (queueItem.usbBookmarkType == 'queue') {
            container += '<li class="play"><a class="shiur" data-href="/sidebar/lecturedata?shiurID=' + shiur.shiurID + '" href="' + shiur.shiurLectureURL + '" data-shiurid="' + shiur.shiurID + '" title="Play this shiur" data-time="' + queueItem.usbBookmarkTimeStamp + '">Play Now</a></li>';
        }
        if (queueItem.usbBookmarkType == 'queue' || queueItem.usbBookmarkType == 'articles') {
            if (userAuthenticated == 1) {
                if (queueItem.shiurCanBeDownloaded == 1 && shiur.shiurFileURL) {
                    container += '<li class="download"><a href="' + shiur.shiurFileURL + '" title="Download this shiur" download target="_blank">download</a></li>';
                } /* else { hide if downloadURL == ""
          container += '<li class="download"><a href="#" class="download" title="This shiur cannot be downloaded">Download</a></li>';
        }*/
            } /*else {
        container += '<li class="download disable"><a href="#" title="Login to use this feature">Download</a></li>';
      }*/
        }
        if (queueItem.usbBookmarkType == 'history' && queueItem.mediaTypeCategory != 'text') {
            container += '<li class="queue"><a href="#" class="queue" title="Add to Queue list">Play Later</a></li>';
        } else if (queueItem.usbBookmarkType == 'history' && queueItem.mediaTypeCategory == 'text') {
            container += '<li class="queue article"><a href="#" class="queue" title="Add to Article list">Read Later</a></li>';
        }
        container += '</ul></div>';
        container += '<div class="btns">';
        if (queueItem.usbBookmarkType == 'queue') {
            container += '<a href="#" class="remove" title="Remove from queue list" data-remove-id="' + shiur.shiurID + '">remove</a>';
        } else if (queueItem.usbBookmarkType == 'articles') {
            container += '<a href="#" class="remove" title="Remove from article list">remove</a>';
        }
        container += '</div>';
        container += '<div class="blcok-holder">';

        if (queueItem.usbBookmarkType != 'history') {
            container += '<div class="counter">';
            container += '<div class="counter-holder">';
            container += '<span>' + (i + 1) + '</span>';
            container += '</div>';
            container += '</div>';
        }

        container += '<div class="textbox">';
        if (queueItem.usbBookmarkType == 'queue' && queueItem.usbIsPlayed == 1) {
            container += '<strong class="title"><a class="shiur" data-href="/sidebar/lecturedata?shiurID=' + shiur.shiurID + '" href="' + shiur.shiurLectureURL + '" data-shiurid="' + shiur.shiurID + '" class="open" data-time="' + queueItem.usbBookmarkTimeStamp + '">' + shiur.shiurTitle + '</a></strong>';
        } else {
            container += '<strong class="title"><a class="shiur" data-href="/sidebar/lecturedata?shiurID=' + shiur.shiurID + '" href="' + shiur.shiurLectureURL + '" data-shiurid="' + shiur.shiurID + '" class="open">' + shiur.shiurTitle + '</a></strong>';
        }
        container += '<div class="meta">';

        if (shiur.shiurTeachers.length <= 1) {
            container += '<a class="teacher" href="' + shiur.shiurTeachers[0].landingPageURL + '" data-href="/teachers/sidebar/' + shiur.shiurTeachers[0].teacherID + _svnRevision + '">' + shiur.shiurTeachers[0].teacherName + '</a>';
        } else {
            $.each(shiur.shiurTeachers, function () {
                container += '<a class="teacher" href="' + this.landingPageURL + '" data-href="/teachers/sidebar/' + this.teacherID + _svnRevision + '">' + this.teacherName + '</a>, ';
            });
        }

        //if (queueItem.shiurDuration) {
        //    container += '<time datetime="' + shiur.shiurDateFormatted + '">' + ' - ' + shiur.shiurDateText + ' - ' + shiur.shiurDuration + '</time>';
        //} else {
        //    container += '<time datetime="' + shiur.shiurDateFormatted + '">' + ' - ' + shiur.shiurDateText + '</time>';
        //}

        container += '</div>';

        if (shiur.shiurLength) {
            var hms = shiur.shiurLength;  // in HH:MM:SS.ms format
            var a = hms.split(':'); // split it at the colons

            // convert to seconds
            shiur.shiurMediaLengthInSeconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);
        }

        if (queueItem.usbIsPlayed == 1 && queueItem.usbBookmarkType == 'queue' && shiur.shiurMediaLengthInSeconds) {
            container += '<div class="tag" data-id="' + shiur.shiurID + '"><div class="time-holder">' + SecondsToHMS(queueItem.usbBookmarkTimeStamp) + ' played - ' + SecondsToHMS(shiur.shiurMediaLengthInSeconds) + ' total</div><div class="progress-holder" style="width:' + ((parseFloat(queueItem.usbBookmarkTimeStamp) / parseFloat(shiur.shiurMediaLengthInSeconds) * 100)) + '%"></div></div>';
        } else if (queueItem.usbIsPlayed == 1 && queueItem.usbBookmarkType == 'queue') {
            container += '<div class="tag" data-id="' + shiur.shiurID + '"><div class="time-holder">' + SecondsToHMS(queueItem.usbBookmarkTimeStamp) + ' played</div><div class="progress-holder" style="width:10%;"></div></div>';
        }
        if (queueItem.usbBookmarkType == 'history') {
            container += '<div class="tag tag-date"><div class="time-holder">Added: ' + queueItem.usbDateAddedToQueue + '</div></div>';
        }

        container += '<div class="detail">';

        if (shiur.shiurDescription !== '' && shiur.shiurDescription !== null) {
            container += '<p class="desc"><strong>Description:</strong> <span>' + shiur.shiurDescription + '</span></p>';
        }

        //var postedIn = $('<p><strong>Posted in: </strong></p>');
        var postedIn = $('<p class="posted-li">');

        // Posted in series
        if (shiur.shiurSeries !== null && shiur.shiurSeries.length > 0) {
            $(postedIn).append($('<span>Series: </span>'));
            getPostedInSeries(shiur, postedIn, false);
            $(postedIn).append($('<br>'));
        }

        // Posted in categories
        //getPostedInCategories(shiur, postedIn, false);

        // Add it to the main container if there are either series or categories
        //if ((shiur.shiurSeries !== null && shiur.shiurSeries.length > 0) || (!$.isEmptyObject(shiur.postedInCategories))) {
        //    container += '<p>' + $(postedIn).html() + '</p>';
        //}

        container += '</div>';
        container += '</div>';
        container += '</div>';
        container += '</div>';

        if (queueItem.usbBookmarkType == 'queue') {
            //$(container).appendTo(queueTabUpcoming);
            if ((queueItem.usbIsPlayed == 1) || (shiur.shiurID == playingShiurID)) {
                container = $.parseHTML(container);
                $(container).find('.counter-holder span').html(counterListened);
                counterListened++;
                $(container).appendTo(queueTabInProgress);
            } else {
                container = $.parseHTML(container);
                $(container).find('.counter-holder span').html(counterNotListened);
                counterNotListened++;
                $(container).appendTo(queueTabUpcoming);
            }
        } else if (queueItem.usbBookmarkType == 'articles') {
            $(container).appendTo(articleTab);
        } else if (queueItem.usbBookmarkType == 'history') {
            $(container).appendTo(historyTab);
        }

        //update attribute data-time on DAF page and on the Lecture page
        $('#jp_container_daf[data-id="' + shiur.shiurID + '"]').attr('data-time', queueItem.usbBookmarkTimeStamp);
        $('#jp_container_lecture[data-id="' + shiur.shiurID + '"]').attr('data-time', queueItem.usbBookmarkTimeStamp);
        $('.post .textbox .title a[data-id="' + shiur.shiurID + '"]').attr('data-time', queueItem.usbBookmarkTimeStamp);
        $('.post .textbox .title a[data-id="' + shiur.shiurID + '"]').parents('.post').find('.add .play a').attr('data-time', queueItem.usbBookmarkTimeStamp);
    });

    // append counters to elements
    if (bookmarkType == 'queue') {
        countQueueItems();
    }

    //remove loading class
    $('.queue-panel').removeClass('loading');

    //addTooltip($('.sidenav li.queue .tab-content #tab1 .remove, .sidenav li.queue .tab-content #tab1 .download'), 'info');
    addTooltip('.sidenav li .tab-content .remove, .sidenav li .tab-content .add li a', 'info');

    //draggable content queue
    if (bookmarkType == 'queue') {
        $(".sidenav li.queue .tab-content .queue-content").sortable({
            handle: ".counter",
            //save current order in array
            update: function (event, ui) {
                // create list of all shiurIDs and all Indexes
                var shiurSortList = '';
                var shiurIDList = '';
                var blockElements = $('.sidenav li.queue .tab-content .queue-content .block');
                $.each(blockElements, function (i) {
                    var shiurID = $(this).attr('data-id');
                    if (i + 1 < blockElements.length) {
                        shiurIDList += shiurID;
                        shiurIDList += 'Ãœ';
                        shiurSortList += (i + 1);
                        shiurSortList += ('Ãœ');
                    } else {
                        shiurIDList += shiurID;
                        shiurSortList += (i + 1);
                    }
                });
                // send shiurIDs and Indexes and update queue
                refreshQueue('update', shiurIDList, 'queue', shiurSortList, '');
            },
            //update counter ui
            stop: function (event, ui) {
                $('.sidenav li.queue .tab-content .queue-content .block').each(function (i) {
                    $(this).find('.counter-holder span').html($(this).index() + 1);
                });
            }
        });
        $(".sidenav li.queue .tab-content .queue-content").disableSelection();
    } else if (bookmarkType == 'articles') {
        $(".sidenav li.articles .tab-content .tab-content-inner").sortable({
            handle: ".counter",
            //save current order in array
            update: function (event, ui) {
                // create list of all shiurIDs and all Indexes
                var shiurSortList = '';
                var shiurIDList = '';
                var blockElements = $('.sidenav li.articles .tab-content .block');
                $.each(blockElements, function (i) {
                    var shiurID = $(this).attr('data-id');
                    if (i + 1 < blockElements.length) {
                        shiurIDList += shiurID;
                        shiurIDList += 'Ãœ';
                        shiurSortList += (i + 1);
                        shiurSortList += ('Ãœ');
                    } else {
                        shiurIDList += shiurID;
                        shiurSortList += (i + 1);
                    }
                });
                // send shiurIDs and Indexes and update queue
                refreshQueue('update', shiurIDList, 'articles', shiurSortList, '');
            },
            //update counter ui
            stop: function (event, ui) {
                $('.sidenav li.articles .tab-content .block').each(function (i) {
                    $(this).find('.counter-holder span').html($(this).index() + 1);
                });
            }
        });
        $(".sidenav li.articles .tab-content").disableSelection();
    }

    if (bookmarkType == 'queue') {
        //search throught queue
        searchInSidenav('input#searchInQueue', '.sidenav > ul > li.queue .queue-content .textbox .title', 'a', 'queue');
    } else if (bookmarkType == 'articles') {
        //search throught articles
        searchInSidenav('input#searchInArticles', '.sidenav > ul > li.articles .textbox .title', 'a', 'articles');
    } else if (bookmarkType == 'history') {
        //search throught history
        //searchInSidenav('input#searchInHistory', '.sidenav > ul > li.history .textbox .title', 'a');
    }

    //init open/close
    var buttonsQueueItems;
    if (bookmarkType == 'queue') {
        initOpenCloseQueueBlock('.sidenav li.queue .queue-content');
        //remove from queue function
        buttonsQueueItems = $('.sidenav li.queue .queue-content .block');
        buttonsQueue(buttonsQueueItems, bookmarkType);
        initAjaxAsideSidebarShiur('.sidenav li.queue .tab-content .title, .sidenav li.queue .tab-content .add .play');
        initAjaxAsideSidebar('.sidenav li.queue .tab-content .teacher, .sidenav li.queue .tab-content .postedin');
    } else if (bookmarkType == 'articles') {
        initOpenCloseQueueBlock('.sidenav li.articles');
        //remove from queue function
        buttonsQueueItems = $('.sidenav li.articles .block');
        buttonsQueue(buttonsQueueItems, bookmarkType);
        initAjaxAsideSidebarShiur('.sidenav li.articles .tab-content .title');
        initAjaxAsideSidebar('.sidenav li.articles .tab-content .teacher, .sidenav li.articles .tab-content .postedin');
    } else if (bookmarkType == 'history') {
        buttonsQueueItems = $('.sidenav li.queue .history-content .block');
        buttonsQueueHistory(buttonsQueueItems, bookmarkType);
        initOpenCloseQueueBlock('.sidenav li.queue .history-content');
        initAjaxAsideSidebarShiur('.sidenav li.queue .history-content .title');
        initAjaxAsideSidebar('.sidenav li.queue .history-content .teacher, .sidenav li.queue .history-content .postedin');
    }
}

//function for showing messages to user
function msgAlert(msg, type) {
    var body = $.find('body');
    var msgPopup = $('<div class="msgPopup-' + type + '">' + msg + '</div>');
    if ($('msgPopup-' + type).length <= 0) {
        $(msgPopup).fadeIn('slow').prependTo(body).delay(2000).slideUp('slow', function () {
            $(this).remove();
        });
    }
    //$(msgPopup).slideDown('slow').prependTo(body).delay(2000).slideUp('slow', function(){$(this).remove();});
}

// Gather user collection and save them to database
function addCollection(uccQuadrantID, uccTitle, uccFiltersSet, uccShiurSearchURLSet) {
    var uccFilters = '';
    var uccShiurSearchURL = '';
    if (uccFiltersSet) {
        uccFilters = uccFiltersSet;
        uccShiurSearchURL = uccShiurSearchURLSet;
    } else {
        var active_filter_items = $('.active_filter_item', $('#userSearchKeywords'));
        if ($(active_filter_items).length > 0) {
            $.each(active_filter_items, function (i, item) {
                var prevItem = $(item).prev();
                if (uccFilters != '') {
                    uccFilters += '|';
                }
                uccFilters += $(prevItem).html();
            });
            uccShiurSearchURL = encodeURIComponent($('#thisLink').val());
        }
        var active_search_items = $('.active_search_term', $('#userSearchKeywords'));
        if ($(active_search_items).length > 0) {
            $.each(active_search_items, function (i, item) {
                var prevItem = $(item).prev();
                if (uccFilters != '') {
                    uccFilters += '|';
                }
                uccFilters += $(prevItem).html();
            });
            uccShiurSearchURL = encodeURIComponent($('#thisLink').val());
        }
    }

    var params = {
        'uccAction': 'add',
        'uccShiurSearchURL': uccShiurSearchURL,
        'uccTitle': uccTitle,
        'uccQuadrantID': uccQuadrantID,
        'uccFilters': uccFilters
    };
    // Slavisa: TODO put email notification on error
    $.ajax({
        url: '/search/SetCustomCollectionContent',
        cache: false,
        type: 'post',
        data: params,
        dataType: 'json',
        async: true,
        success: function (data) {
            msgAlert('Collection added successfully.', 'good');
        },
        error: function (jqXHR, exception) {
            msgAlert(jqXHR.responseJSON.errorMessage, 'error');
            // ajaxErrorHandler(jqXHR, exception);
        }
    });
}

//show popup on search page on add to home link click
function initShowPopupHome() {
    var homeButton = $('#addToHomePage');
    var body = $('body');
    var uccTitle = '';
    if (homeButton.length > 0) {
        $(homeButton).on('click', function (e) {
            body.addClass('popup-active');
            // Slavisa: TODO put email notification on error
            ajaxLoadContent('/search/GetHomePopup', 'html', false, function (data) {
                $(data).fadeIn().prependTo(body);
            });
            return false;
        });

        $('body').on('click', function (e) {
            if ($(e.target).is('a.close') || $(e.target).is('a.close i')) {
                $('.overlayPopup').fadeOut('fast', function () { $(this).remove(); });
                body.removeClass('popup-active');
                return false;
            }
            var popupBoxes = $('.popupBox');
            $.each(popupBoxes, function (index) {
                var popupBox = $(this);
                if ($(e.target).is('.popupBox' + (index + 1)) || $(e.target).is('.popupBox' + (index + 1) + ' .popupBoxInner')) {
                    if ($('input[name="uccTitle' + (index + 1) + '"]').val() != '') {
                        uccTitle = $('input[name="uccTitle' + (index + 1) + '"]').val();
                        addCollection((index + 1), uccTitle);
                        popupBox.addClass('popupActive');
                        $('.overlayPopup').fadeOut('fast', function () { $(this).remove() });
                        body.removeClass('popup-active');
                    } else {
                        popupBox.addClass('popupError');
                        msgAlert('Please insert collection title.', 'error');
                    }
                }
            });
        });
    }
}

// Update the "Timely" section
var initUpdateTimelySection = function () {
    return;

    if ($('#timelySection').length > 0) {
        var currentDate = $.format.date(new Date(), 'yyyy-MM-dd');

        // Mishna Yomi
        ajaxLoadContent(_siteURL + '/orayta/get_mishna_record.php?date=' + currentDate, 'json', false, function (data) {
            var mishnaYomi = '';
            var mishnaYomiHref = '';

            if (typeof data['FirstSubcategoryName'] != 'undefined') {
                mishnaYomi = data['FirstSubcategoryName'] + ' ';

                if (typeof data['SecondSubcategoryName'] != 'undefined') {
                    if (data['FirstSubcategoryName'] == data['SecondSubcategoryName']) {
                        if (typeof data['FirstTier2Number'] != 'undefined') {
                            mishnaYomi += data['FirstTier2Number'];
                        }
                        if (typeof data['FirstTier3Number'] != 'undefined') {
                            if (data['FirstTier2Number'] != data['FirstTier3Number']) {
                                mishnaYomi += ':' + data['FirstTier3Number'];
                            }
                        }

                        if (typeof data['SecondTier2Number'] != 'undefined') {
                            mishnaYomi += ' - ' + data['SecondTier2Number'];
                        }
                        if (typeof data['SecondTier3Number'] != 'undefined') {
                            if (data['SecondTier2Number'] != data['SecondTier3Number']) {
                                mishnaYomi += ':' + data['SecondTier3Number'];
                            }
                        }
                    } else {
                        if (typeof data['FirstTier2Number'] != 'undefined') {
                            mishnaYomi += data['FirstTier2Number'];
                        }
                        if (typeof data['FirstTier3Number'] != 'undefined') {
                            if (data['FirstTier2Number'] != data['FirstTier3Number']) {
                                mishnaYomi += ':' + data['FirstTier3Number'];
                            }
                        }

                        mishnaYomi += ' - ' + data['SecondSubcategoryName'];
                        if (typeof data['SecondTier2Number'] != 'undefined') {
                            mishnaYomi += ' ' + data['SecondTier2Number'];
                        }
                        if (typeof data['SecondTier3Number'] != 'undefined') {
                            if (data['SecondTier2Number'] != data['SecondTier3Number']) {
                                mishnaYomi += ':' + data['SecondTier3Number'];
                            }
                        }
                    }
                }

                if (typeof data['FirstSubcategoryID'] != 'undefined') {
                    mishnaYomiHref = _siteURL + '/search/?category=0,' + data['FirstSubcategoryID'];
                }
                if (typeof data['SecondSubcategoryID'] != 'undefined') {
                    if (data['FirstSubcategoryID'] != data['SecondSubcategoryID']) {
                        mishnaYomiHref += ',' + data['SecondSubcategoryID'];
                    }
                }
            }

            if ((mishnaYomi != '') && (mishnaYomiHref != '')) {
                $('#timelySectionMishnaYomi').find('strong').find('a').attr('href', mishnaYomiHref);
                $('#timelySectionMishnaYomi').find('p').find('a').html(mishnaYomi);
                $('#timelySectionMishnaYomi').find('p').find('a').attr('href', mishnaYomiHref);
                $('#timelySectionMishnaYomi').removeClass('hide-element');
            }
        });

        // Nach Yomi
        ajaxLoadContent(_siteURL + '/orayta/get_bible_record.php?date=' + currentDate, 'json', false, function (data) {
            var nachYomi = '';
            var nachYomiHref = '';

            if (typeof data['SubcategoryName'] != 'undefined') {
                nachYomi = data['SubcategoryName'];

                if (typeof data['Tier2Number'] != 'undefined') {
                    nachYomi += ' ' + data['Tier2Number'];
                }

                if (typeof data['SubcategoryID'] != 'undefined') {
                    nachYomiHref = _siteURL + '/search/?category=0,' + data['SubcategoryID'];
                }
            }

            if ((nachYomi != '') && (nachYomiHref != '')) {
                $('#timelySectionNachYomi').find('strong').find('a').attr('href', nachYomiHref);
                $('#timelySectionNachYomi').find('p').find('a').html(nachYomi);
                $('#timelySectionNachYomi').find('p').find('a').attr('href', nachYomiHref);
                $('#timelySectionNachYomi').removeClass('hide-element');
            }
        });
    }
};

// update user collections on home page
function initUpdateHomeCollectionBoxes() {
    var body = $('body');
    var button = $('.twocolumns .setting-box .opener');
    if (button.length > 0 && isMobile() == false) {
        if (userAuthenticated == 1) {
            var saveButton = $('<a class="save" href="#" title="Save changes and close collection manager"><i class="fa fa-check-circle"></i></a>');
            var deleteButton = $('<a class="delete" href="#" title="Delete collection"><i class="fa fa-trash-o"></i> Remove</a>');
            var refreshAll = false;
            var error = '';
            $(button).on('click', function (e) {
                body.addClass('popup-active');
                // Slavisa: TODO put email notification on error
                ajaxLoadContent('/search/GetHomePopup', 'html', false, function (data) {
                    $(data).fadeIn().prependTo(body);
                    $('.popupHome').addClass('popupReorder');
                    $('.popupTitle h3').html('Drag and reorder collections, or delete by clicking on the "Remove" button');

                    $('.popupActive .popupBoxInner').after(deleteButton);
                    var titleBox = $('.popupBoxTitle input[type="text"]');

                    $(".popupHolder").draggable({
                        revert: false,
                        helper: "clone",
                        /*opacity: 0.75,*/
                        drag: function (event, ui) {
                            $('.ui-state-hover').parent().addClass('ui-state-hover-parent');
                            if ($('.popupHolder').hasClass('ui-state-active')) {
                                $('.ui-state-active').parent().addClass('ui-state-hover-parent-active');
                            } else {
                                $('.popupHolder').parent().removeClass('ui-state-hover-parent-active');
                            }
                        },
                        stop: function (event, ui) {
                            $('.popupHolder').parent().removeClass('ui-state-hover-parent');
                            $('.popupHolder').parent().removeClass('ui-state-hover-parent-active');
                        }
                    });
                    $(".popupHolder").droppable({
                        accept: ".popupHolder",
                        activeClass: "ui-state-hover",
                        hoverClass: "ui-state-active",
                        drop: function (event, ui) {
                            var draggable = ui.draggable, droppable = $(this),
                                dragPos = draggable.position(), dropPos = droppable.position();

                            draggable.css({
                                left: dropPos.left + 'px',
                                top: dropPos.top + 'px'
                            });

                            droppable.css({
                                left: dragPos.left + 'px',
                                top: dragPos.top + 'px'
                            });
                            draggable.swap(droppable);

                            $('.popupTitle .close').after(saveButton);
                            $('.popupHolder').parent().removeClass('ui-state-hover-parent');
                        },
                        stop: function (event, ui) {
                            $('.popupHolder').parent().removeClass('ui-state-hover-parent');
                            $('.popupHolder').parent().removeClass('ui-state-hover-parent-active');
                        }
                    });

                    titleBox.on('change', function () {
                        $('.popupTitle .close').after(saveButton);
                    });
                });

                deleteButton.on('click', function () {
                    var id = $(this).parent().parent().parent().attr('id');
                    removeCollection(id);
                    $('.overlayPopup').fadeOut('fast', function () { $(this).remove(); });
                    $('#ajax-load-col-' + findColor(id)).html('');
                    getCustomCollectionContent('ajax-load-col-' + findColor(id), id, findColor(id));
                    body.removeClass('popup-active');
                });

                //TODO: Check everything one more time
                saveButton.on('click', function () {
                    $('.popupHolder').each(function () {
                        var item = $(this);
                        var id = item.parent().attr('id');
                        var uccTitle;
                        if (item.find('li').length > 0) {
                            if (item.find('input[type="text"]').val() != '') {
                                var uccURL = item.find('ul').attr('data-url');
                                var filters = '';
                                $.each(item.find('ul li'), function (i, itemLi) {
                                    if (filters != '') {
                                        filters += '|';
                                    }
                                    filters += $(itemLi).html();
                                });
                                uccTitle = item.find('input[type="text"]').val();
                                addCollection(id, uccTitle, filters, uccURL);
                                //$('.twocolumns .frame').html('');
                                //getCustomCollectionContent('ajax-load-col-'+ findColor(id), id, findColor(id));
                                userJSON.myCustomCollections[id] = true;
                                //refreshAll = true;
                            } else {
                                error += 'error collection title';
                                //refreshAll = false;
                                item.parent().addClass('popupError');
                                msgAlert('Please insert collection title.', 'error');
                            }
                        } else {
                            // if replace with empty box, delete it
                            removeCollection(id, 'noMsg');
                            //getCustomCollectionContent('ajax-load-col-'+ findColor(id), id, findColor(id));
                            userJSON.myCustomCollections[id] = false;
                        }
                    });
                    if (/*refreshAll == true &&*/ error == '') {
                        $('.twocolumns .frame').html('');
                        setTimeout(function () {
                            initCustomCollectionContent();
                        }, 300);
                        $('.overlayPopup').fadeOut('fast', function () { $(this).remove(); });
                    } else {
                        error = '';
                    }
                    body.removeClass('popup-active');
                    return false;
                });
                return false;
            });
            $('body').on('click', function (e) {
                if ($(e.target).is('a.close') || $(e.target).is('a.close i')) {
                    $('.overlayPopup').fadeOut('fast', function () { $(this).remove(); });
                    body.removeClass('popup-active');
                    return false;
                }
            });
        } else {
            button.attr('title', 'Login to use this feature');
            addTooltip(button, 'info');
            showLoginPanel(button);
        }
    }
}

function findColor(id) {
    var color;
    switch (id) {
        case '1':
            color = 'red';
            break;
        case '2':
            color = 'blue';
            break;
        case '3':
            color = 'green';
            break;
        case '4':
            color = 'purple';
            break;
    }
    return color;
}

//remove collection from 4 boxes on home page
function removeCollection(uccQuadrantID, noMsg) {
    var params = {
        'uccAction': 'remove',
        'uccQuadrantID': uccQuadrantID
    };
    // Slavisa: TODO put email notification on error
    $.ajax({
        url: '/search/SetCustomCollectionContent',
        cache: false,
        type: 'post',
        data: params,
        dataType: 'json',
        async: true,
        success: function (data) {
            if (!noMsg) {
                msgAlert('Collection removed successfully.', 'good');
            }
        },
        error: function (jqXHR, exception) {
            msgAlert(jqXHR.responseJSON.errorMessage, 'error');
            // ajaxErrorHandler(jqXHR, exception);
        }
    });
}

//multiple teachers image slideshow
function imgSlideShow(el, isLecture) {
    var imgHolder = $(el);
    if (imgHolder.length > 0) {
        $.each(imgHolder, function () {
            var item = $(this);
            if ((typeof isLecture != 'undefined') && (isLecture == 'lecture')) {
                if (item.find('a.avatar').length > 1) {
                    item.cycle({
                        timeout: 2000,
                        delay: 0,
                        speed: 500,
                        fx: 'fade',
                        slideExpr: 'a'
                    });
                }
            } else {
                if (item.find('img').length > 1) {
                    item.cycle({
                        timeout: 2000,
                        delay: 0,
                        speed: 500,
                        fx: 'fade'
                    });
                }
            }
        });
    }
}

// It gets the custom collection content
var getCustomCollectionContent = function (id, quadrantID, color) {
    if (id !== '') {
        if ($('#' + id).length > 0) {
            var params = {
                'id': id,
                'quadrantID': quadrantID,
                'color': color
            };

            // Angel: TODO complete the .N tcode to retrieve this data
            $.ajax({
                url: '/search/GetCustomCollectionContent',
                cache: false,
                type: 'post',
                data: params,
                dataType: 'json',
                async: true,
                success: function (data) {
                    //console.info(data);
                    loadCustomCollectionContent(data, color);
                },
                error: function (jqXHR, exception) {
                    ajaxErrorHandler(jqXHR, exception);
                }
            });
        }
    }
};

//load data into 4 boxes on home page
function loadCustomCollectionContent(data, color) {
    $('.twocolumns .' + color + ' .loading-boxes').remove();
    var containerHolder = $('.' + color);
    var container = $('#ajax-load-col-' + color).hide();

    $('.' + color + ' .heading h2').html(data.collectionTitle);
    $(data.collectionShiurimHTMLSnippet).appendTo(container);

    container.slideDown('slow', refreshFixedBanner()).show();

    imgSlideShow('.' + color + ' .img-holder');
    initFeaturedButtons(('.' + color + ' .frame .post'));
    editShiur('.' + color);

    var button = $('.' + color + ' .ajax-load-more-col');
    if (button.length <= 0) {
        $('.btn-more[data-container="ajax-load-col-' + color + '"]').remove();
        button = $('<a href="#" class="btn-more ajax-load-more-col" data-container="ajax-load-col-' + color + '"><span>More</span></a>').appendTo(containerHolder);
    }

    button.on('click', function () {
        var posts = $('.' + color + ' .frame .post');
        $.each(posts, function () {
            $(this).fadeIn('slow').show();
        });
        refreshFixedBanner();
        $(this).remove();
        createSearchButton();
        return false;
    });

    function createSearchButton() {
        if ($('.btn-more[data-container="ajax-load-col-' + color + '"]').length <= 0) {
            var button = $('<a href="' + data.collectionSearchURL + '" class="btn-more" data-container="ajax-load-col-' + color + '"><span>Search for more</span></a>');
            $(button).appendTo(containerHolder);
        } else {
            $('.btn-more[data-container="ajax-load-col-' + color + '"]').remove();
            var button = $('<a href="' + data.collectionSearchURL + '" class="btn-more" data-container="ajax-load-col-' + color + '"><span>Search for more</span></a>');
            $(button).appendTo(containerHolder);
        }
    }
}

//when 4 boxes on home page visible load content
function initCustomCollectionContent() {
    var colRed = $('#ajax-load-col-red');
    if (colRed.length > 0) {
        var twoCols = $('#main .twocolumns');
        var getCollection1 = once(function () {
            if (userJSON.myCustomCollections["1"] == true) {
                colRed.html('');
                getCustomCollectionContent('ajax-load-col-red', 1, 'red');
            } else {
                if (windowWidth <= 767) {
                    getCustomCollectionContent('ajax-load-col-red', 1, 'red');
                } else {
                    twoCols.find('.red .heading h2').html('Did you know?');
                    twoCols.find('.red .loading-boxes').remove();
                    twoCols.find('.ajax-load-more-col[data-container="ajax-load-col-red"]').remove();
                    var img = $('<img src="' + _cdnPublicURL + 'images/did-you-know.jpg" alt="Did you know">');
                    img.appendTo(twoCols.find('#ajax-load-col-red')).hide().slideDown('slow').show();
                }
            }
        });
        var getCollection2 = once(function () {
            twoCols.find('#ajax-load-col-blue').html('');
            getCustomCollectionContent('ajax-load-col-blue', 2, 'blue');
        });
        var getCollection3 = once(function () {
            twoCols.find('#ajax-load-col-green').html('');
            getCustomCollectionContent('ajax-load-col-green', 3, 'green');
        });
        var getCollection4 = once(function () {
            twoCols.find('#ajax-load-col-purple').html('');
            getCustomCollectionContent('ajax-load-col-purple', 4, 'purple');
        });

        var loader = $('<div class="loading-boxes"></div>');
        loader.prependTo(twoCols.find('.holder'));

        if (windowWidth >= 1024) {
            //if visible on page load
            if (twoCols.find('.red').visible(true) && twoCols.find('.blue').visible(true)) {
                getCollection1();
                getCollection2();
            }
            if (twoCols.find('.green').visible(true) && twoCols.find('.purple').visible(true)) {
                getCollection3();
                getCollection4();
            }

            //if visible on click anywhere
            $('#home-tabs-area .tabset .slide a').on('click', function () {
                if (twoCols.find('.red').visible(true) && twoCols.find('.blue').visible(true)) {
                    getCollection1();
                    getCollection2();
                }
                if (twoCols.find('.green').visible(true) && twoCols.find('.purple').visible(true)) {
                    getCollection3();
                    getCollection4();
                }
            });
            var scroller = $('#wrap-holder');

            //if visible on scrolling
            scroller.on('scroll', function () {
                if (twoCols.find('.red').visible(true) && twoCols.find('.blue').visible(true)) {
                    getCollection1();
                    getCollection2();
                }
                if (twoCols.find('.green').visible(true) && twoCols.find('.purple').visible(true)) {
                    getCollection3();
                    getCollection4();
                }
            });
        }
        else {
            var scroller = $('body');
            // if visible on  page load
            if (twoCols.find('.red').visible(true)) {
                getCollection1();
            }
            if (twoCols.find('.blue').visible(true)) {
                getCollection2();
            }
            if (twoCols.find('.green').visible(true)) {
                getCollection3();
            }
            if (twoCols.find('.purple').visible(true)) {
                getCollection4();
            }
            // if visible on scrolling
            scroller.on('click touchstart pointerdown MSPointerDown', function () {
                getCollection1();
                getCollection2();
                getCollection3();
                getCollection4();
            });
        }
    }
}

//add tooltip to an element //type can be info, error, good
//info [class=qtip-plain], error [class="qtip-red"], good [class="qtip-green"]
function addTooltip(el, type, elPosition1, elPosition2, elPosition3, elPosition4) {
    //var title;
    var tooltipClass = '';
    switch (type) {
        case 'info':
            //title = 'Information';
            tooltipClass += 'qtip-plain';
            break;
        case 'error':
            //title = 'Error';
            tooltipClass += 'qtip-red';
            break;
        case 'good':
            //title = 'Information';
            tooltipClass += 'qtip-green';
            break;
    }

    if (!elPosition1 && !elPosition2 && !elPosition3 && !elPosition4) {
        elPosition1 = 'bottom';
        elPosition2 = 'center';
        elPosition3 = 'top';
        elPosition4 = 'center';
    }

    $(el).qtip({
        content: {
            attr: 'title'
            //title: title
        },
        style: {
            widget: false,
            classes: tooltipClass + ' qtip-shadow qtip-rounded qtip-tipsy'
        },
        position: { my: elPosition1 + ' ' + elPosition2, at: elPosition3 + ' ' + elPosition4 }
    }).addClass('has-qtip');
}

//search throught sidenav queue, articles
function searchInSidenav(inputEl, searchString, selector, type) {
    $(inputEl).quicksearch(searchString, {
        'delay': 100,
        'selector': selector,
        'loader': 'span.loading',
        'noResults': '.sidenav .' + type + ' .tab-content p.noresults',
        'bind': 'keyup keydown',
        'minValLength': 1,
        'removeDiacritics': false,
        'show': function () {
            $(this).parent().parent().parent().removeClass('hide-element');
        },
        'hide': function () {
            $(this).parent().parent().parent().addClass('hide-element');
        },
        'onBefore': function () {
            $(this).on("keyup keypress", function (e) {
                var code = e.keyCode || e.which;
                if (code == 13) {
                    e.preventDefault();
                    return false;
                }
            });
        }
    });

    if (type == 'queue') {
        var buttonClear = $('.sidenav .queue #queue-form #searchInQueueyClear').hide();
        buttonClear.on('click touchstart', function () {
            $('#searchInQueue').val('');
            $(this).hide();
            $('.sidenav .queue .tab-content .noresults').hide();
            $('.sidenav .queue #tab1 .block').removeClass('hide-element');
            $('.sidenav .queue #tab2 .block').removeClass('hide-element');
            return false;
        });

        $(inputEl).on('keyup', function () {
            if ($(this).val() != '') {
                buttonClear.show();
            } else {
                buttonClear.hide();
            }
        });
    }

    if (type == 'articles') {
        var buttonClear = $('.sidenav .articles #searchInArticlesClear').hide();
        buttonClear.on('click touchstart', function () {
            $('#searchInArticles').val('');
            $(this).hide();
            $('.sidenav .articles .tab-content .noresults').hide();
            $('.sidenav .articles .tab-content .block').removeClass('hide-element');
            return false;
        });

        $(inputEl).on('keyup', function () {
            if ($(this).val() != '') {
                buttonClear.show();
            } else {
                buttonClear.hide();
            }
        });
    }
}

//search throught sidenav history
function searchInHistory(inputEl) {
    var buttonSubmit = $('.sidenav .queue #history-form button');
    var pattern = /^[A-Za-z\d\s]+$/;
    var buttonClear = $('.sidenav .queue #history-form #searchInHistoryClear').hide();

    buttonSubmit.on('click touchstart', function () {
        var inputText = $(inputEl).val();
        if ((inputText.length >= 3) && (pattern.test(inputText) == true)) {
            refreshQueue('get', 000000, 'history', 0, inputText);
        }
        return false;
    });

    buttonClear.on('click touchstart', function () {
        $(inputEl).val('');
        $(this).hide();
        refreshQueue('get', 000000, 'history', 0, '');
        $('.sidenav .queue .queue-panel').addClass('loading');
        $('.sidenav .queue .tab-content .noresults').hide();
        return false;
    });

    $(inputEl).on('keyup', function () {
        if ($.trim($(this).val()) != '') {
            buttonClear.show();
        } else {
            buttonClear.hide();
            $('.sidenav .queue .tab-content .noresults').hide();
            refreshQueue('get', 000000, 'history', 0, '');
            $('.sidenav .queue .queue-panel').addClass('loading');
        }
    });
}

/// sidenav custom scrollbar ///////
function setHeight(scrollHolder, scrollerHeight, winHeight, searchBox, tabHeading) {
    var height;
    if ($(scrollHolder).scrollTop() >= 180) {
        scrollerHeight = winHeight - searchBox;
        $('.sidenav .queue-panel').css('top', '0px');
        $('.sidenav .mCustomScrollbar').css('height', (scrollerHeight - tabHeading) + 'px');
        /*$('.sidenav .history .mCustomScrollbar').css('height', scrollerHeight + 'px');*/
    } else {
        scrollerHeight = winHeight - searchBox - 180 + $(scrollHolder).scrollTop();
        $('.sidenav .queue-panel').css('top', '-10px');
        $('.sidenav .mCustomScrollbar').css('height', (scrollerHeight - tabHeading) + 'px');
        /*$('.sidenav .history .mCustomScrollbar').css('height', scrollerHeight + 'px');*/
    }
    height = scrollerHeight;
    return height;
}

function scrollInSidenav() {
    $('.queue-panel .tab-content').mCustomScrollbar('destroy');
    var winWidth = $(window).width(),
        winHeight = $(window).height(),
        headerHeight = $('#header').height();
    if (winWidth >= 1024) {
        var scrollHolder = $('#wrap-holder');

        var searchBox = 48,
            tabHeading = 55,
            scrollerHeight;

        setHeight(scrollHolder, scrollerHeight, winHeight, searchBox, tabHeading);
        scrollerHeight = setHeight(scrollHolder, scrollerHeight, winHeight, searchBox, tabHeading);

        $('.queue-panel .tab-content').mCustomScrollbar({
            theme: 'minimal-dark',
            setHeight: (scrollerHeight - tabHeading) + 'px',
            scrollInertia: 400,
            autoExpandScrollbar: true
        });

        scrollHolder.on('scroll', function () {
            setHeight(scrollHolder, scrollerHeight, winHeight, searchBox, tabHeading);
        });

    } else {
        $('.sidenav .queue-panel').css({
            'max-height': (winHeight - headerHeight) + 'px',
            'min-height': (winHeight - headerHeight) + 'px'
        });
    }
}
//////////////////////////////////

// if mobile update content
function initMobileLayout() {
    if (windowWidth <= 1023) {
        //destroy all tooltips
        $('.has-qtip').each(function () {
            $(this).data('qtip').destroy();
        });
        //login box
        $('.login-area > li a.login-link').unbind();
        $('.login-area > li a.login-link').magnificPopup({
            items: {
                src: '.login-drop',
                type: 'inline'
            },
            //closeOnBgClick: false,
            fixedContentPos: true,
            overflowY: 'scroll',
            mainClass: 'login-popup',
            alignTop: true
        });
    }
    if (windowWidth <= 767 /*&& isMobile() == true*/) {
        //update footer lightbox size
        //create <select> element for header timely section
        $("#timely-header").tinyNav({
            header: 'Timely'
        });
        //additional menu item with support link
        var supportBox = $('.support-box > a');
        var label = supportBox.find('strong').html();
        var desc = supportBox.attr('title');
        var link = supportBox.attr('href');
        var supportLi = $('<li class="support"><a class="opener-drop" href="' + link + '" target="_blank">' + label + '<span>(' + desc + ')</span></a></li>');
        supportLi.appendTo($('#nav > ul'));
        //lecture page ask teacher form update
        if ($('.lecture-page .ask-teacher').length > 0) {
            var oldLink = $('.lecture-page .ask-teacher').attr('href');
            var newLink = oldLink.replace('width=480', 'width=320');
            $('.lecture-page .ask-teacher').attr('href', newLink);
        }
    }
    if (isTouchDevice()) {
        document.documentElement.className += " touch-device";
    }
}

// Home Page: Share page -- Show lecture sidebar
var initSharePageLectureSidebar = function (url) {
    if (url.indexOf('/sidebar/lectures/') > -1 || url.indexOf('/sidebar/lecturedata/') > -1) {
        var urlElements = url.replace(_siteURL + '/sidebar/lectures/', '').replace(_siteURL + '/sidebar/lecturedata/', '').split('/');

        if (typeof urlElements[0] != 'undefined') {
            var shiurID = urlElements[0];
            //var shiurATag = $('#content').find('a[data-id="' + shiurID +'"]');
            var shiurATag = $('<a data-id="' + shiurID + '" data-type="audio" data-href="' + _siteURL + '/sidebar/lecturedata?shiurID=' + shiurID + '" href="' + _siteURL + '/lectures/details?shiurID=' + shiurID + '" class="shiur"></a>');
            if ($(shiurATag).length > 0) {
                //var item = $(shiurATag[0]).parent();
                //var link = $(item).find('a.shiur');
                //var itemClass = $(item).attr('class');
                //var playerTime = $(link).attr('data-time');
                var link = shiurATag;
                var itemClass = '';
                var playerTime = '';
                var playerStatus = '';
                console.log('initAjaxSidebarShiurClick', 'initSharePageLectureSidebar');
                initAjaxSidebarShiurClick(link, itemClass, playerTime, playerStatus);
            }
        }
    }
};
// Home Page: Share page -- Show teacher sidebar
var initSharePageTeacherSidebar = function (url) {
    if (url.indexOf('/sidebar/teacher/') > -1 || url.indexOf('/sidebar/teacher.cfm/') > -1) {
        var urlElements = url.replace(_siteURL + '/sidebar/teacher/', '').replace(_siteURL + '/sidebar/teacher.cfm/', '').split('/');
        if (typeof urlElements[0] != 'undefined') {
            var teacherID = urlElements[0];
            var teacherDataHref = _siteURL + '/teachers/sidebar/' + teacherID;
            //var teacherATag = $('#content').find('a[data-href="' + teacherDataHref +'"]');
            var teacherATag = $('<a data-href="' + teacherDataHref + '" href="#" class="teacher" itemprop="url"><span itemprop="name" class="speaker-name"></span></a>');
            if ($(teacherATag).length > 0) {
                var item = $(teacherATag[0]);
                var url = $(item).attr('data-href');
                sidebarDesktopClickHandler(item, url);
            }
        }
    }
};
// Home Page: Share page -- Show category sidebar
var initSharePageCategorySidebar = function (url) {
    if (url.indexOf('/sidebar/category/') > -1 || url.indexOf('/sidebar/category.cfm/') > -1) {
        var urlElements = url.replace(_siteURL + '/sidebar/category/', '').replace(_siteURL + '/sidebar/category.cfm/', '').split('/');
        if (typeof urlElements[0] != 'undefined') {
            var subcategoryID = urlElements[0];
            //var subcategoryDataHref = _siteURL + '/categories/sidebar/' + subcategoryID + '.html';
            var subcategoryDataHref = `${_siteURL}/categories/sidebar/${subcategoryID}`;
            //var subcategoryATag = $('#content').find('a[data-href="' + subcategoryDataHref +'"]');
            var subcategoryATag = $('<a data-href="' + subcategoryDataHref + '" href="#" class="postedin"></a>');
            if ($(subcategoryATag).length > 0) {
                var item = $(subcategoryATag[0]);
                var url = $(item).attr('data-href');
                sidebarDesktopClickHandler(item, url);
            }
        }
    }
};
// Home Page: Share page -- Show series sidebar
var initSharePageSeriesSidebar = function (url) {
    if (url.indexOf('/sidebar/series/') > -1 || url.indexOf('/sidebar/series.cfm/') > -1) {
        var urlElements = url.replace(_siteURL + '/sidebar/series/', '').replace(_siteURL + '/sidebar/series.cfm/', '').split('/');
        if (typeof urlElements[0] != 'undefined') {
            var seriesID = urlElements[0];
            // var seriesDataHref = _siteURL + '/series/sidebar/' + seriesID + '.html';
            var seriesDataHref = `${_siteURL}/series/sidebar/${seriesID}`;
            //var seriesATag = $('#content').find('a[data-href="' + seriesDataHref +'"]');
            var seriesATag = $('<a data-href="' + seriesDataHref + '" href="#"></a>');
            if ($(seriesATag).length > 0) {
                var item = $(seriesATag[0]);
                var url = $(item).attr('data-href');
                sidebarDesktopClickHandler(item, url);
            }
        }
    }
};
// Home Page: Share page -- Show location sidebar
var initSharePageVenuesSidebar = function (url) {
    if (url.indexOf('/sidebar/location/') > -1 || url.indexOf('/sidebar/location.cfm/') > -1) {
        var urlElements = url.replace(_siteURL + '/sidebar/location/', '').replace(_siteURL + '/sidebar/location.cfm/', '').split('/');
        if (typeof urlElements[0] != 'undefined') {
            var locationID = urlElements[0];
            var locationDataHref = _siteURL + '/venues/sidebar/' + locationID;
            //var locationATag = $('#content').find('a[data-href="' + locationDataHref +'"]');
            var locationATag = $('<a data-href="' + locationDataHref + '" href="#" class="postedin"><span itemprop="address name" class="address"></span></a>');
            if ($(locationATag).length > 0) {
                var item = $(locationATag[0]);
                var url = $(item).attr('data-href');
                sidebarDesktopClickHandler(item, url);
            }
        }
    }
};

//detect if element is in viewport
; (function (e) { e.fn.visible = function (t, n, r) { var i = e(this).eq(0), s = i.get(0), o = e(window), u = o.scrollTop(), a = u + o.height(), f = o.scrollLeft(), l = f + o.width(), c = i.offset().top, h = c + i.height(), p = i.offset().left, d = p + i.width(), v = t === true ? h : c, m = t === true ? c : h, g = t === true ? d : p, y = t === true ? p : d, b = n === true ? s.offsetWidth * s.offsetHeight : true, r = r ? r : "both"; if (r === "both") return !!b && m <= a && v >= u && y <= l && g >= f; else if (r === "vertical") return !!b && m <= a && v >= u; else if (r === "horizontal") return !!b && y <= l && g >= f } })(jQuery);

// Load addthis.js on demand only on home page and only for sidebar
function loadAddThis(el, title) {
}

// FIXME: Throws addthis is not defined exception
function initAddThis(el, title) {
    //addthis.toolbox(el);
    //addthis.update('share', 'url', title);
}

var bulkDownload = function (object, bookmarkType) {
    var shiurIDs = '';
    if (bookmarkType === 'articles') {
        var aTags = $(object).parent().next().find('[data-shiurid]');
        if (aTags.length > 0) {
            $.each(aTags, function (index, value) {
                var shiurID = $(value).attr('data-shiurid');
                if (shiurIDs != '') {
                    shiurIDs += ',';
                }

                if (shiurID != '') {
                    shiurIDs += shiurID;
                }
            });

            if (shiurIDs != '') {
                $('#bdlBookmarkType').val(bookmarkType);
                $('#bdlShiurIDs').val(shiurIDs);
                $('#formBulkDownloadList').submit();
                /*
                var params = {
                  'bookmarkType': bookmarkType,
                  'shiurIDs': shiurIDs
                };
                $.ajax({
                  type: 'post',
                  url: _siteURL + '/queue/queue_bulkDownload.cfm',
                  data: params,
                  success: function(data) {
                    console.info('data: ' + data);
                  }
                });
                */
            } else {
                msgAlert('Nothing to download. Please add something to the article list and try again.', 'error');
            }
        }
    } else if (bookmarkType === 'audio/video') {
        var params = {
            'action': 'get',
            'shiurID': '000000',
            'bookmarkType': 'queue',
            'sortIndex': '0',
            'historySearchTerm': ''
        };
        $.ajax({
            url: '/queue/queue',
            cache: false,
            type: 'post',
            data: params,
            dataType: 'json',
            async: true,
            success: function (data) {
                var queueList = '';
                if ($.isEmptyObject(data.data) && data.isError == true) {
                    msgAlert('There was an error loading your content. Please try again in a few minutes', 'error');
                }
                if (!$.isEmptyObject(data)) {
                    var limit = 1;
                    $.each(data.data, function (i) {
                        if (queueList != '') {
                            queueList += ',';
                        }
                        limit++;
                        queueList += this.shiurID;
                        if (limit >= 51) {
                            msgAlert('WARNING: iTunes links support a maximum of 50 shiurim.', 'error');
                            return false;
                        }
                    });
                }
                if (queueList != '') {
                    var pUrl = _siteURL.replace('http://', 'itpc://');
                    pUrl += '/RSS/getAudioShiurim.cfm?shiurIDlst=' + queueList + '&numberOfRssResults=' + data.data.length + '&queueBulkDownload=true&x=31&y=12';

                    $(location).attr('href', pUrl);

                } else {
                    msgAlert('Your queue is empty. Please add shiurim in the queue and try again.', 'good');
                }
            },
            error: function (jqXHR, exception) {
                ajaxErrorHandler(jqXHR, exception);
            }
        });
    }
    //msgAlert('Not connected.\n Verify Network.', 'error');
};
