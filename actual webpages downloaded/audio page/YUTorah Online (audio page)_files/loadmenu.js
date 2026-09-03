$(document).ready(function () {
    loadMenu();
    document.getElementById('templateSearchBox').select();
});
var isSetScroller = 0;
var isSetScrollerVenues = 0;
var venuesAll;

function loadMenu() {
    var today = new Date();
    var dd = today.getDate();
    var mm = today.getMonth() + 1; // January == 0
    var yyyy = today.getFullYear();
    if (dd < 10) {
        dd = '0' + dd;
    }
    if (mm < 10) {
        mm = '0' + mm;
    }
    today = mm + '-' + dd + '-' + yyyy;

    var url = '';
    // load full menu for desktop/tablet devices
    if ((windowWidth >= 1024) && (isMobile() == false)) {
        url += '/partials/_navSnippet.html';
        url += _svnRevision;
        if (_svnRevision != '') {
            url += '&cachedOn=' + today;
        } else {
            url += '?cachedOn=' + today;
        }

        ajaxLoadContent(url, 'html', true, function (data) {
            initNavDrop(data);
            initDropDownClasses();
            initLayout2();
            initOpenCloseMenu(data);
            //menuTeachersFilter();
            //menuSeriesFilter();
            //menuVenuesFilter();
            hideQueue();
            //loadFavoriteTeachers('#nav');
            //loadFavoriteSeries('#nav');
            //loadFavoriteVenues('#nav');
            //loadFavoritePublications('#nav');
            //addFavoritesTeachersFromNav();
            //addFavoritesSeriesFromNav();
            //addFavoritesVenuesFromNav();
            //addFavoritesPublicationsFromNav();
            loadFavorites();
        });
        // load only root items for mobile
    } else {
        url += '/mobileNav?showNav=';
        $('#navCategoriesHolderGemara').find('.open-drop').attr('href', url + 'Gemara');
        $('#navCategoriesHolderHalacha').find('.open-drop').attr('href', url + 'Halacha');
        $('#navCategoriesHolderMachshava').find('.open-drop').attr('href', url + 'Machshava');
        $('#navCategoriesHolderParsha').find('.open-drop').attr('href', url + 'Parsha');
        $('#navCategoriesHolderHolidays').find('.open-drop').attr('href', url + 'Holidays');
        $('#navCategoriesHolderMishna').find('.open-drop').attr('href', url + 'Mishna');
        $('#navCategoriesHolderHistory').find('.open-drop').attr('href', url + 'History');
        $('#navTeachersHolder').find('.opener-drop').attr('href', url + 'Teachers');
        $('#navSeriesHolder').find('.opener-drop').attr('href', url + 'Series');
        $('#mobile .series').find('.head-note a').attr('href', url + 'Venues');
        $('#navVenuesHolder').find('.opener-drop').attr('href', url + 'Venues');
        $('#navPublicationHolder').find('.opener-drop').attr('href', url + 'Publications');
        initDropDownClasses();
        initLayout2();
        initOpenCloseMenu();

        //loadFavoriteTeachers('#mobile');
        //loadFavoriteSeries('#mobile');
        //loadFavoriteVenues('#mobile');
        //loadFavoritePublications('#mobile');
    }
}

// run only once functions
var runMenuTeachers = once(function () { setTimeout(function () { menuTeachersFilter(); loadFavoriteTeachers('#nav'); addFavoritesTeachersFromNav(); }, 200); });
var runMenuSeries = once(function () { menuSeriesFilter(); addFavoritesSeriesFromNav(); loadFavoriteSeries('#nav'); });
var runMenuVenues = once(function () { menuVenuesFilter(); addFavoritesVenuesFromNav(); loadFavoriteVenues('#nav'); });
var runMenuPublications = once(function () { addFavoritesPublicationsFromNav(); loadFavoritePublications('#nav'); });

// drop navigation
function initNavDrop(data) {
    var navData = $(data);
    var navCategoriesHolderGemara = $('#navCategoriesHolderGemara');
    var navCategoriesHolderHalacha = $('#navCategoriesHolderHalacha');
    var navCategoriesHolderMachshava = $('#navCategoriesHolderMachshava');
    var navCategoriesHolderParsha = $('#navCategoriesHolderParsha');
    var navCategoriesHolderHolidays = $('#navCategoriesHolderHolidays');
    var navCategoriesHolderMishna = $('#navCategoriesHolderMishna');
    var navCategoriesHolderHistory = $('#navCategoriesHolderHistory');
    var navTeachersHolder = $('#navTeachersHolder');
    var navSeriesHolder = $('#navSeriesHolder');
    var navPublicationHolder = $('#navPublicationHolder');
    var navVenuesHolder = $('#navVenuesHolder');

    var navCategoriesDropDownGemara = navData.find('div[id="navCategoriesDropDownGemara"]');
    var navCategoriesDropDownHalacha = navData.find('div[id="navCategoriesDropDownHalacha"]');
    var navCategoriesDropDownMachshava = navData.find('div[id="navCategoriesDropDownMachshava"]');
    var navCategoriesDropDownParsha = navData.find('div[id="navCategoriesDropDownParsha"]');
    var navCategoriesDropDownHolidays = navData.find('div[id="navCategoriesDropDownHolidays"]');
    var navCategoriesDropDownMishna = navData.find('div[id="navCategoriesDropDownMishna"]');
    var navCategoriesDropDownHistory = navData.find('div[id="navCategoriesDropDownHistory"]');
    var navTeachersDropDown = navData.find('div[id="navTeachersDropDown"]');
    var navSeriesDropDown = navData.find('div[id="navSeriesDropDown"]');
    var navPublicationsDropDown = navData.find('div[id="navPublicationsDropDown"]');
    var navVenuesDropDown = navData.find('div[id="navVenuesDropDown"]');

    navCategoriesDropDownGemara.appendTo(navCategoriesHolderGemara);
    navCategoriesDropDownHalacha.appendTo(navCategoriesHolderHalacha);
    navCategoriesDropDownMachshava.appendTo(navCategoriesHolderMachshava);
    navCategoriesDropDownParsha.appendTo(navCategoriesHolderParsha);
    navCategoriesDropDownHolidays.appendTo(navCategoriesHolderHolidays);
    navCategoriesDropDownMishna.appendTo(navCategoriesHolderMishna);
    navCategoriesDropDownHistory.appendTo(navCategoriesHolderHistory);
    navTeachersDropDown.appendTo(navTeachersHolder);
    navSeriesDropDown.appendTo(navSeriesHolder);
    navPublicationsDropDown.appendTo(navPublicationHolder);
    navVenuesDropDown.appendTo(navVenuesHolder);
    venuesAll = navVenuesDropDown;

    var body = $('body');
    //var menuHolder = $(body.find('.panel-holder'));
    //$(data).appendTo(menuHolder);      

    //var isTouchDevice = /MSIE 10.*Touch/.test(navigator.userAgent) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch || (navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent));
    //var mobileDeviceClass = 'mobile-device';
    //var animSpeed = 200; //300
    //var mobileWidth = 767;
    //var isIE10 = navigator.appVersion.indexOf("MSIE 10") !== -1;
    var win = $(window);
    var timer;
    //var hiddenClassDElay = 1000;

    $('#nav').each(function () {
        var nav = $(this);
        var timer;

        nav.on('mouseenter', function () {
            clearTimeout(timer);
            body.addClass('item-active');
        });
        nav.on('mouseleave', function () {
            clearTimeout(timer);
            body.removeClass('item-active');
            timer = setTimeout(function () {
                if (win.width() > 1023) {
                    body.removeClass('item-active');
                }
            }, 1000);
        });

    });

    /* only calculate the top tier LI's onPageLoad */
    $('#nav > ul > li').each(setDropdownEvents);
}

function setDropdownEvents(eventTarget) {
    var item = $(this);
    var drop = item.find('> .dropdown, > .sub-drop');
    var hideTimer;
    var delay = 500;//500
    var showTimer;
    var isTouchDevice = /MSIE 10.*Touch/.test(navigator.userAgent) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch || (navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent));
    var animSpeed = 200; //300

    ResponsiveHelper.addRange({
        '768..': {
            on: function () {
                // On page load check if mouse is over element
                if (item.is(':hover')) {
                    showDrop();
                }

                item.on(isTouchDevice ? 'itemhover' : 'mouseenter', showDrop);
                item.on(isTouchDevice ? 'itemleave' : 'mouseleave', hideDrop);
            },
            off: function () {
                item.off(isTouchDevice ? 'itemhover' : 'mouseenter', showDrop);
                item.off(isTouchDevice ? 'itemleave' : 'mouseleave', hideDrop);
            }
        }
    });

    function showDrop() {
        //item.addClass('hover');
        //console.log(item.context.id);
        // setup the menu layout only on hover
        switch (item.context.id) {
            case 'navTeachersHolder':
                {
                    runMenuTeachers();
                }
            case 'navSeriesHolder':
                {
                    runMenuSeries();
                }
            case 'navVenuesHolder':
                {
                    runMenuVenues();
                }
            case 'navPublicationHolder':
                {
                    runMenuPublications();
                }
        }

        /* when a nav element is opened, check to see if it has ever been laid out */
        if (item.dropdownsEnabled != true) {
            /* if it hasn't, wire the events, responsive layout */
            item.dropdownsEnabled = true;
            item.find("li.level2").each(setDropdownEvents);
        }
        //drop.slideDown(animSpeed);
        clearTimeout(hideTimer);
        showTimer = setTimeout(function () {
            if (drop.length) {
                drop.stop().slideDown({
                    duration: animSpeed,
                    complete: function () {
                        // on animation complete create scrollbar
                        createScroll($(this).context.id);
                    }
                });
            }
        }, delay);
    }

    function hideDrop() {
        //drop.slideUp(animSpeed);
        clearTimeout(showTimer);
        hideTimer = setTimeout(function () {
            if (drop.length) {
                drop.stop().slideUp({
                    duration: animSpeed,
                    complete: function () {
                        // on animation complete disable scrollbar
                        disableScroll($(this).context.id);
                    }
                });
            }
        }, delay);
        //focus on top search bar
        document.getElementById('templateSearchBox').select();
    }
}

function initDropDownClasses() {
    $('#nav > ul > li').each(function () {
        var item = $(this);
        var drop = item.find('.js-drop');
        var link = item.find('a').eq(0);
        if (drop.length) {
            item.addClass('has-drop-down');
            if (link.length)
                link.addClass('has-drop-down-a');
        }
    });
    $('#nav > ul li.level2').each(function () {
        var item = $(this);
        var drop = item.find('.js-drop');
        var link = item.find('a').eq(0);
        if (drop.length) {
            item.addClass('has-drop-down');
            if (link.length)
                link.addClass('has-drop-down-a');
        }
    });
}

// responsive and touch layout handling
function initLayout2() {
    // find elements
    var nav = $('#nav'),
        dropHolders = $('.has-drop-down'),
        dropdawns = $('.dropdown');

    var isTouchDevice = (/MSIE 10.*Touch/.test(navigator.userAgent)) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch;

    // handle layout resize
    ResponsiveHelper.addRange({
        '..766': {
            on: function () {
                initAccordion();
            },
            off: function () {
                destroy(nav.children().add(dropdawns.children()), 'SlideAccordion');
            }
        },
        '767..1023': {
            on: function () {
                initOpenClose2();
            },
            off: function () {
                destroy(dropHolders, 'OpenClose');
            }
        },
        '1024..': {
            on: function () {
                // initDropDown();
                if (isTouchDevice)
                    initOpenClose2();
                dropHolders.on('click', function () {
                    var item = $(this);
                    switch (item.context.id) {
                        case 'navTeachersHolder':
                            {
                                runMenuTeachers();
                            }
                        case 'navSeriesHolder':
                            {
                                runMenuSeries();
                            }
                        case 'navVenuesHolder':
                            {
                                runMenuVenues();
                            }
                        case 'navPublicationHolder':
                            {
                                runMenuPublications();
                            }
                    }
                });
            },
            off: function () {
                // destroy(nav, 'AnimDropdown');
                if (isTouchDevice)
                    destroy(dropHolders, 'OpenClose');
            }
        }
    });

    // animated navigation init
    function initDropDown() {
        nav.animDropdown({
            items: '.has-drop-down',
            drop: '>.js-drop',
            animSpeed: 0,
            delay: 100,
            effect: 'fade'
        });
    }
    function initOpenClose2() {
        dropHolders.openClose({
            hideOnClickOutside: true,
            activeClass: 'drop-active',
            opener: '>.has-drop-down-a',
            slider: '>.js-drop',
            animSpeed: 400,
            effect: 'none',
            event: !isTouchDevice ? 'over' : 'click'
        });
    }
    function initAccordion() {
        nav.find('> ul').slideAccordion({
            activeClass: 'drop-active',
            opener: '>.has-drop-down-a',
            slider: '>.js-drop',
            animSpeed: 300,
            collapsible: true
        });
    }

    function destroy(elem, pluginName) {
        elem.each(function () {
            var inst = $(this).data(pluginName);
            if (inst) {
                inst.destroy();
            }
        })
    }
}

function hideQueue() {
    //if menu is active
    $('#nav').on('mouseenter', function () {
        if ($('body').hasClass('body-active-top')) {
            $('body').removeClass('body-active-top');
            $('.sidenav > ul > li').removeClass('menu-active');
        }
    });
}

function initOpenCloseMenu(data) {
    var isTouchDevice = (/MSIE 10.*Touch/.test(navigator.userAgent)) || ('ontouchstart' in window) || window.DocumentTouch && document instanceof DocumentTouch,
        isWinPhoneDevice = navigator.msPointerEnabled && /MSIE 10.*Touch/.test(navigator.userAgent)
    var event = isTouchDevice ? (isWinPhoneDevice ? 'click' : 'touchend') : 'click';
    ResponsiveHelper.addRange({
        '..1023': {
            on: function () {
                $(data).find('.nav-holder').openClose({
                    hideOnClickOutside: true,
                    activeClass: 'active',
                    opener: '.opener',
                    slider: '.slide',
                    animSpeed: 400,
                    effect: 'none',
                    onInit: function () {
                        var self = this;
                        var win = $(window);

                        win.on('resize orientationchange', function () {
                            if (self.holder.hasClass(self.options.activeClass) && win.width() < 1024) {
                                $('body').addClass('item-active');
                            }
                        });
                    },
                    onBeforeShow: function () {
                        var self = this;

                        $('.nav-holder').each(function () {
                            var holder = $(this);

                            if (holder.is(self.holder))
                                return;

                            if (holder.data('OpenClose') && holder.hasClass(self.options.activeClass)) {
                                holder.data('OpenClose').hideSlide();
                            }
                        });
                        $('body').addClass('item-active');
                    },
                    onBeforeHide: function () {
                        $('body').removeClass('item-active');
                    }
                });

                //fix for smaller resolution navigation
                $(data).find('.nav-holder .opener').on('click', function (e) {
                    if ($(e.target).is($(this)) && $('.nav-holder').hasClass('active')) {
                        $('.sidenav').css('z-index', '9');
                    }
                    else {
                        $('.sidenav').css('z-index', '100');
                    }
                })

                $('body').on('click', function (e) {
                    if (!$(e.target).is($('.nav-holder .opener')) && !$(e.target).is($('.nav-holder .slide'))) {
                        $('.sidenav').css('z-index', '100');
                    }
                });
                //fix for smaller resolution navigation

            },
            off: function () {
                $(data).find('.nav-holder').each(function () {
                    var holder = $(this);

                    if (holder.data('OpenClose')) {
                        holder.data('OpenClose').destroy();
                    }
                    $('body').removeClass('item-active');
                });
            }
        }
    });
}

// create scrollbar on menu slidedown
function createScroll(element) {
    //teachers
    if (element == 'navTeachersDropDown') {
        if (isSetScroller == 1) {
            setTimeout(function () {
                //$('#nav .teachers-filter-results .mCSB_container').css('left', '0');
                $('.teachers-filter-results').mCustomScrollbar("update").mCustomScrollbar("scrollTo", "left");
            }, 0);
        } else {
            setTimeout(function () {
                setScroller('#teacherA', 'x');
                isSetScroller = 1;
            }, 10);
        }

        //focus on search box
        $('#filterByMenuTeacher').select();
    }

    //series
    if (element == 'navSeriesDropDown') {
        $('#filterByMenuSeries').select();
    }

    //venues
    if (element == 'navVenuesDropDown') {
        if (isSetScrollerVenues == 1) {
            setTimeout(function () {
                //$('#nav .venues-filter-results .mCSB_container').css('left', '0');
                $('.venues-filter-results').mCustomScrollbar("update").mCustomScrollbar("scrollTo", "left");
            }, 0);
        } else {
            setTimeout(function () {
                setScroller('.venues-results-holder', 'x');
                isSetScrollerVenues = 1;
            }, 10);
        }

        //focus on search box
        $('#filterByMenuVenues').select();
    }
}

// disable scrollbar on menu slideup
function disableScroll(element) {
    //teachers
    if (element == 'navTeachersDropDown') {
        $('.teachers-filter-results').mCustomScrollbar("disable");
    }

    //venues
    if (element == 'navVenuesDropDown') {
        $('.venues-filter-results').mCustomScrollbar("disable");
    }
}

function menuTeachersFilter() {
    var holder = $('.teachers-filter-results');
    var resultItems = $('.teacher-results-holder');
    var headerLetters = $('#thead-letters');
    var buttonPrev = $('<a class="nav-slide-prev" href="#"><i class="fa fa-arrow-left"></i></a>');
    var buttonNext = $('<a class="nav-slide-next" href="#"><i class="fa fa-arrow-right"></i></a>');

    // if is touch device and resoultion less then 1280px
    if ((isTouchDevice() == true) && (windowWidth <= 1280)) {
        //$('#nav .teachers .opener-drop').on('click', function () {
        $('#filterByMenuTeacher').val('');
        setScroller('#teacherA', 'x');
        isSetScroller = 1;
        //});
    }

    //on load show A teachers and disable all letters
    resultItems.first().removeClass('hide-element');
    headerLetters.find('li').addClass('disable');
    setWidth('#teacherA');
    //setScroller('#nav #teacherA', 'x');

    //if no items disable letter
    $.each(resultItems, function () {
        var linkChar = $(this).attr('id').replace('teacher', '');
        headerLetters.find('a[data-tletter="' + linkChar + '"]').parent().removeClass('disable');
    });

    //add prev, next buttons
    if (!isTouchDevice()) {
        buttonPrev.appendTo(holder.parent());
    }

    buttonPrev.hide().on('click', function () {
        holder.mCustomScrollbar("scrollTo", "+=650");
        buttonNext.show();
        return false;
    });

    if (!isTouchDevice()) {
        buttonNext.appendTo($('#nav .teachers-filter-results').parent());
    }
    buttonNext.on('click', function () {
        holder.mCustomScrollbar("scrollTo", "-=650");
        buttonPrev.show();
        return false;
    });

    $('.teacher-results-holder').each(function () {
        setColumns($(this));
    });

    headerLetters.find('a').each(function () {
        var item = $(this);
        if (item.parent().hasClass('disable')) {
            item.removeAttr('href');
        } else {
            item.on('click', function (e) {
                if (!item.hasClass('active')) {
                    headerLetters.find('a').removeClass('active');
                    item.addClass('active');
                    if (holder.hasClass('teacher-searching')) {
                        holder.removeClass('teacher-searching');
                        holder.mCustomScrollbar("destroy");
                        setScroller('#teacherA', 'x');
                    }
                    holder.find('.noresults').hide();
                    $('#filterByMenuTeacher').val('');
                    resultItems.find('ul li').removeClass('hide-element');
                    resultItems.find('ul ul').addClass('sub-list');
                    resultItems.removeClass('teacher-search-active').addClass('hide-element').css('width', '0px');
                    $('#teacher' + item.html()).removeClass('hide-element');
                    setWidth('#teacher' + item.html());
                    holder.find('.mCSB_container').css('width', '0px');
                    holder.mCustomScrollbar('update').mCustomScrollbar('scrollTo', 'left');
                    /*if(isTouchDevice()){
                      setTimeout(function(){
                        holder.mCustomScrollbar('update').mCustomScrollbar('scrollTo', 'left');
                      }, 100);
                    } else {
                      holder.mCustomScrollbar('update').mCustomScrollbar('scrollTo', 'left');
                    }*/
                    if (($('#teacher' + item.html()).width() >= 990) || (windowWidth < 1366)) {
                        buttonNext.show();
                        //buttonPrev.show();
                    } else {
                        buttonNext.hide();
                        buttonPrev.hide();
                    }
                    if (item.html() != 'A') {
                        clearAllFilterButton();
                    } else {
                        $('.clear-all-filters-teacher').parent().hide();
                    }
                }
                e.preventDefault();
                return false;
            });
        }
    });

    // global var for searching
    var onSearch = 0;

    //button for clearing all filters
    function clearAllFilterButton() {
        if ($('#nav .clear-all-filters-teacher').length <= 0) {
            var clearBtn = $('<li><a class="clear-all-filters-teacher" href="#" title="Clear all filters">X</a></li>')
                .appendTo($('#nav .teachers-filter-letters'));
            //addTooltip
            addTooltip('.clear-all-filters-teacher', 'info');
            clearBtn.on('click', function () {
                resultItems.addClass('hide-element');
                resultItems.find('ul li').removeClass('hide-element');
                resultItems.find('ul ul').addClass('sub-list');
                resultItems.first().removeClass('hide-element');
                resultItems.removeClass('teacher-search-active');
                $(this).hide();
                headerLetters.find('a').removeClass('active');
                headerLetters.find('a').first().addClass('active');
                $('#filterByMenuTeacher').val('');
                onSearch = 0;
                holder.find('.noresults').hide();
                resultItems.css('width', '0px');
                holder.find('.mCSB_container').css('width', '0px');
                setWidth('#teacherA');
                if (isTouchDevice()) {
                    setTimeout(function () {
                        holder.mCustomScrollbar('update').mCustomScrollbar('scrollTo', 'left');
                    }, 100);
                } else {
                    holder.mCustomScrollbar('update').mCustomScrollbar('scrollTo', 'left');
                }
                buttonNext.show();
                if (holder.hasClass('teacher-searching')) {
                    holder.removeClass('teacher-searching').mCustomScrollbar("destroy");
                    setScroller('#teacherA', 'x');
                    holder.mCustomScrollbar("scrollTo", "left");
                    isSetScroller = 1;
                    buttonPrev.hide();
                }
                return false;
            });
        } else {
            $('.clear-all-filters-teacher').parent().show();
        }
    }

    //make changes to list to show all results in one row
    $('#filterByMenuTeacher').on('keyup' /* input change keydown*/, function () {
        if ($(this).val() !== '') {
            if (onSearch == 0) {
                onSearch = 1;
                resultItems.find('ul ul').removeClass('sub-list');
                resultItems.removeAttr('style').addClass('teacher-search-active').removeClass('hide-element');
                resultItems.find('ul li').addClass('hide-element');
                headerLetters.find('a').removeClass('active');
                holder.addClass('teacher-searching').mCustomScrollbar("destroy");
                setScroller('#teacherA', 'y');
                clearAllFilterButton();
                buttonNext.hide();
                buttonPrev.hide();
            }
        } else {
            if (onSearch == 1) {
                onSearch = 0;
                resultItems.find('ul ul').addClass('sub-list').removeClass('hide-element');
                resultItems.addClass('hide-element').removeClass('teacher-search-active');
                resultItems.first().removeClass('hide-element');
                headerLetters.find('a').removeClass('active').first().addClass('active');
                holder.removeClass('teacher-searching').mCustomScrollbar("destroy");
                resultItems.css('width', '0px');
                setWidth('#teacherA');
                setScroller('#teacherA', 'x');
                buttonNext.show();
                buttonPrev.hide();
                $('.clear-all-filters-teacher').parent().hide();
            }
        }
    });

    //search throught teachers
    $('#filterByMenuTeacher').quicksearch('.teachers-filter-results li', {
        'delay': 100,
        'selector': 'a.nav-item',
        'loader': 'span.loading',
        'noResults': '.teachers .holder p.noresults',
        'bind': 'keyup keydown',
        'minValLength': 2,
        'removeDiacritics': false,
        'show': function () {
            $(this).removeClass('hide-element');
        },
        'hide': function () {
            $(this).addClass('hide-element');
        }
    });
}

function menuSeriesFilter() {
    makeCols(3, '#nav .series-results-holder ul', '', '', 17);
    setScroller('#nav .series-results-holder', 'y');

    /* Filtering functions not using currently - 5/16/2016 START */
    /*var lettersItems = $('#nav ul.series-filter-letters > li');
    $.each(lettersItems, function () {
      var item = $(this);
      item.on('click', function (e) {
        e.preventDefault();
        $('#nav .series-filter-results .noresults').hide();
        $('#nav ul.series-filter-letters li').removeClass('active');
        $('#nav #filterByMenuSeries').val('');
        $('#nav .series-results-holder ul li').removeClass('hide-element');
        $('#nav .series-results-holder').removeClass('series-search-active');
        $('#nav .series-results-holder ul ul').addClass('sub-list');
        item.addClass('active');
        filterByLetters(item.index());
        //call function to add button for clearing all filters
        if(item.index() != 0){
            clearAllFilterButton();
          } else {
            $('.clear-all-filters-series').remove();
          }
        return false;
      });
    });
  
    //function for filtering by letters click
    function filterByLetters(index) {
      $('#nav .series-filter-results .series-results-holder').addClass('hide-element');
      $('#nav .series-filter-results .series-results-holder:nth-child(' + (index + 1) + ')').removeClass('hide-element');
    }
  
    //button for clearing all filters
    function clearAllFilterButton() {
      if ($('#nav .clear-all-filters-series').length <= 0) {
        $('<li><a class="clear-all-filters-series" href="#" title="Clear all filters">X</a></li>').appendTo($('#nav .series-filter-letters'));
        //addTooltip
        addTooltip('#nav .clear-all-filters-series', 'info');
        $('#nav .clear-all-filters-series').on('click', function () {
          var item = $(this);
          $('#nav .series-filter-results .noresults').hide();
          $('#nav .series-filter-results .series-results-holder').addClass('hide-element');
          $('#nav .series-results-holder ul li').removeClass('hide-element');
          $('#nav .series-results-holder ul ul').addClass('sub-list');
          $('#nav .series-filter-results .series-results-holder:first-child').removeClass('hide-element');
          $('#nav .series-results-holder').removeClass('series-search-active');
          $('#nav .clear-all-filters-series').qtip('destroy', true);
          item.remove();
          $('#nav .series-filter-letters > li').removeClass('active');
          $('#nav .series-filter-letters > li:first-child').addClass('active');
          $('#nav input#filterByMenuSeries').val('');
          return false;
        });
      }
    }
    */
    /* Filtering functions not using currently - 5/16/2016 END */

    //make changes to list to show all results in one row
    $('#filterByMenuSeries').on('input', function () {
        if ($(this).val() !== '') {
            $('#nav .series-results-holder ul ul').removeClass('sub-list');
            $('#nav .series-results-holder').addClass('series-search-active').removeClass('hide-element');
            $('#nav .series-results-holder ul li').addClass('hide-element');
            $('#nav .series-filter-letters > li').removeClass('active');
            $('#nav .series-results-holder ul li .title').parent().addClass('hide-element');
            //clearAllFilterButton();
        } else {
            $('#nav .series-results-holder ul ul').addClass('sub-list').removeClass('hide-element');
            $('#nav .series-results-holder').addClass('hide-element');
            $('#nav .series-filter-results .series-results-holder:first-child').removeClass('hide-element');
            $('#nav .series-filter-letters > li:first-child').addClass('active');
            $('#nav .series-results-holder').removeClass('series-search-active');
            $('#nav .series-results-holder ul li .title').parent().removeClass('hide-element');
            $('#nav .series-results-holder ul li').removeClass('hide-element');
        }
    });

    $('.series-results-holder .title').each(function () {
        var item = $(this);
        if (item.parent().prev('li').length > 0) {
            item.parent().addClass('title-li');
        } else {
            item.parent().removeClass('title-li');
        }
    });

    //search throught series
    $('#filterByMenuSeries').quicksearch('.series-filter-results li.searchable', {
        'delay': 100,
        'selector': 'a.nav-item',
        'loader': 'span.loading',
        'noResults': '.series-filter-results p.noresults',
        'bind': 'keyup keydown',
        'minValLength': 1,
        'removeDiacritics': false,
        'show': function () {
            $(this).removeClass('hide-element');
        },
        'hide': function () {
            $(this).addClass('hide-element');
        }
    });

    //Add html content to third column
    /*var menuNote = $('<li class="menu-note"><div>Browse our collection of series to find the style of content you’re looking for.</div>\n\
  <div>If you’re searching for shiurim that look place at a particular location, use our new Venues navigation menu.</div></li>');
    $('.series-results-holder ul ul.sub-list:last-child').append(menuNote);*/
}

function menuVenuesFilter() {
    // if is touch device and resoultion less then 1280px
    if ((isTouchDevice() == true) && (windowWidth <= 1280)) {
        //$('#nav .venues .opener-drop').on('click', function () {
        $('#filterByMenuVenues').val('');
        setScroller('#nav .venues-results-holder', 'x');
        isSetScrollerVenues = 1;
        //});
    }

    var venuesAll = $('#nav .venues-results-holder li');
    $('#nav .venues-results-holder ul li[data-num="0"]').removeClass('visible').addClass('hide-element');
    $('#nav .venues-results-holder ul li[data-num="1"]').removeClass('visible').addClass('hide-element');
    $('#nav .venues-results-holder ul li[data-num="2"]').removeClass('visible').addClass('hide-element');
    $('#nav .venues-results-holder ul li[data-num="3"]').removeClass('visible').addClass('hide-element');
    $('#nav .venues-results-holder ul li[data-num="4"]').removeClass('visible').addClass('hide-element');

    var numItems = 15;
    setWidth('#nav .venues-results-holder', 'visible', numItems);
    //setWidth('#nav .venues-results-holder');

    //add prev, next buttons
    var buttonPrev = $('<a class="nav-slide-prev" href="#"><i class="fa fa-arrow-left"></i></a>');
    if (!isTouchDevice()) {
        buttonPrev.appendTo($('#nav .venues-filter-results').parent());
    }
    buttonPrev.hide().on('click', function () {
        $('#nav .venues-filter-results.mCustomScrollbar').mCustomScrollbar("scrollTo", "+=650");
        buttonNext.show();
        return false;
    });

    var buttonNext = $('<a class="nav-slide-next" href="#"><i class="fa fa-arrow-right"></i></a>');
    if (!isTouchDevice()) {
        buttonNext.appendTo($('#nav .venues-filter-results').parent());
    }
    buttonNext.on('click', function () {
        $('#nav .venues-filter-results.mCustomScrollbar').mCustomScrollbar("scrollTo", "-=650");
        buttonPrev.show();
        return false;
    });

    setColumns($('#nav .venues-results-holder'), 'visible', numItems);
    //setColumns($('#nav .venues-results-holder'));

    var lettersItems = $('#nav ul.venues-filter-letters li a');
    $.each(lettersItems, function () {
        var item = $(this);
        if (item.parent().hasClass('disable')) {
            item.removeAttr('href');
        } else {
            item.on('click', function (e) {
                $('#nav ul.venues-filter-letters li a').removeClass('active');
                var scrollToid = item.attr('data-id');
                var scrollTo = $('.title[data-id="' + scrollToid + '"]').parent().parent();
                $('#nav .venues-filter-results.mCustomScrollbar').mCustomScrollbar("scrollTo", scrollTo);
                item.addClass('active');
                e.preventDefault();
                return false;
            });
        }
    });

    function addPadding() {
        $('.venues-holder-list .title').each(function () {
            var item = $(this);
            if (item.parent().prev('li').length > 0) {
                item.parent().addClass('title-li');
            } else {
                item.parent().removeClass('title-li');
            }
        });
    }
    addPadding();

    $('#nav .fitler-form-radio input[name="viewVenues"]').on('change', function () {
        var item = $(this);
        var itemId = item.attr('id');
        $('#nav ul.venues-filter-letters li a').removeClass('active');
        if (item.is(':checked')) {
            if (itemId == 'viewAll') {
                $('#nav .venues-holder-list').children().remove();
                venuesAll.appendTo($('#nav .venues-holder-list'));
                addFavoritesVenuesFromNav();
                loadFavorites();
                $('#nav .venues-results-holder').removeClass('column-set');
                setWidth('#nav .venues-results-holder', '', numItems);
                setColumns($('#nav .venues-results-holder'), '', numItems);
                $('#nav .venues-filter-results.mCustomScrollbar').mCustomScrollbar("destroy");
                setScroller('#nav .venues-results-holder', 'x');
                buttonPrev.hide();
                $('#nav .venues-results-holder ul li').removeClass('hide-element');
                addPadding();
            }
            if (itemId == 'viewFivePlus') {
                $('#nav .venues-holder-list').children().remove();
                venuesAll.appendTo($('#nav .venues-holder-list'));
                addFavoritesVenuesFromNav();
                loadFavorites();
                $('#nav .venues-results-holder').removeClass('column-set');
                $('#nav .venues-results-holder').css('width', '0px').removeAttr('style');
                setWidth('#nav .venues-results-holder', 'visible', numItems);
                setColumns($('#nav .venues-results-holder'), 'visible', numItems);
                $('#nav .venues-filter-results.mCustomScrollbar').mCustomScrollbar("destroy");
                setScroller('#nav .venues-results-holder', 'x');
                buttonPrev.hide();
                $('#nav .venues-results-holder ul li[data-num="0"]').addClass('hide-element');
                $('#nav .venues-results-holder ul li[data-num="1"]').addClass('hide-element');
                $('#nav .venues-results-holder ul li[data-num="2"]').addClass('hide-element');
                $('#nav .venues-results-holder ul li[data-num="3"]').addClass('hide-element');
                $('#nav .venues-results-holder ul li[data-num="4"]').addClass('hide-element');
                //hideParent();
                addPadding();
            }
        }
    });

    //make changes to list to show all results in one row
    $('#filterByMenuVenues').on('keyup' /* input change keydown*/, function () {
        if ($(this).val() !== '') {
            $('#nav .venues-holder-list').children().remove();
            venuesAll.appendTo($('#nav .venues-holder-list'));
            addFavoritesVenuesFromNav();
            loadFavorites();
            $('#nav .venues-results-holder').removeAttr('style').addClass('venues-search-active');
            $('#nav .venues-results-holder ul li.searchable').addClass('hide-li').removeClass('hide-element');
            $('#nav .venues-filter-letters li a').removeClass('active');
            $('#nav .venues-filter-letters li').addClass('disable');
            $('#nav .venues-filter-results.mCustomScrollbar').addClass('venues-searching').mCustomScrollbar("destroy");
            setScroller('#nav .venues-results-holder', 'y');

            $('#nav .venues-results-holder ul li .title').parent().addClass('hide-element');

            buttonNext.hide();
            buttonPrev.hide();
            $('#nav .fitler-form-radio input[name="viewVenues"]').prop('disabled', 'disabled');
            $('#nav .fitler-form-radio input#viewFivePlus').removeAttr('checked');
            $('#nav .fitler-form-radio input#viewAll').prop('checked', 'checked');
        } else {
            $('#nav .venues-results-holder ul li.searchable').removeClass('hide-li');
            $('#nav .venues-results-holder').removeClass('venues-search-active');
            $('#nav .venues-filter-results.mCustomScrollbar').removeClass('venues-searching');
            $('#nav .venues-filter-letters li').removeClass('disable');

            $('#nav .venues-holder-list').children().remove();
            venuesAll.appendTo($('#nav .venues-holder-list'));
            addFavoritesVenuesFromNav();
            loadFavorites();
            $('#nav .venues-results-holder').removeClass('column-set');
            $('#nav .venues-results-holder').css('width', '0px').removeAttr('style');
            setWidth('#nav .venues-results-holder', 'visible', numItems);
            setColumns($('#nav .venues-results-holder'), 'visible', numItems);
            $('#nav .venues-filter-results.mCustomScrollbar').mCustomScrollbar("destroy");
            setScroller('#nav .venues-results-holder', 'x');
            buttonNext.show();
            buttonPrev.hide();

            $('#nav .fitler-form-radio input[name="viewVenues"]').removeAttr('disabled');
            $('#nav .fitler-form-radio input#viewAll').removeAttr('checked');
            $('#nav .fitler-form-radio input#viewFivePlus').prop('checked', 'checked');

            $('#nav .venues-results-holder ul li .title').parent().removeClass('hide-element');

            $('#nav .venues-results-holder ul li[data-num="0"]').addClass('hide-element');
            $('#nav .venues-results-holder ul li[data-num="1"]').addClass('hide-element');
            $('#nav .venues-results-holder ul li[data-num="2"]').addClass('hide-element');
            $('#nav .venues-results-holder ul li[data-num="3"]').addClass('hide-element');
            $('#nav .venues-results-holder ul li[data-num="4"]').addClass('hide-element');

            $('#nav .venues-filter-letters li a').first().addClass('active');
        }
    });

    //search throught venues
    $('#filterByMenuVenues').quicksearch('.venues-filter-results li.searchable', {
        'delay': 100,
        'selector': 'a.nav-item',
        'loader': 'span.loading',
        'noResults': '.venues .holder p.noresults',
        'bind': 'keyup keydown',
        'minValLength': 2,
        'removeDiacritics': false,
        'show': function () {
            $(this).removeClass('hide-li');
        },
        'hide': function () {
            $(this).addClass('hide-li');
        }
    });
}

// make columns in nav
function makeCols(cols, containerEl, elClass, subEl, maxItemsPerColumn) {
    var num_cols = cols,
        container = $(containerEl);
    var listItem;
    if (elClass) {
        listItem = 'li.' + elClass;
    } else {
        listItem = 'li';
    }
    var listClass;
    if (subEl) {
        listClass = 'menu-column';
        listItem = '.teacher-search-active';
    } else {
        listClass = 'sub-list';
    }

    container.each(function () {
        var items_per_col = [],
            items = $(this).find(listItem);
        var min_items_per_col;
        if (maxItemsPerColumn != 0) {
            min_items_per_col = maxItemsPerColumn;
        } else {
            min_items_per_col = Math.floor(items.length / num_cols);
        }
        var difference = items.length - (min_items_per_col * num_cols);
        for (var i = 0; i < num_cols; i++) {
            if (i < difference) {
                items_per_col[i] = min_items_per_col + 1;
            } else {
                items_per_col[i] = min_items_per_col;
            }
        }
        for (var i = 0; i < num_cols; i++) {
            if (subEl) {
                $(this).append($('<div ></div>').addClass(listClass));
            } else {
                $(this).append($('<ul ></ul>').addClass(listClass));
            }
            for (var j = 0; j < items_per_col[i]; j++) {
                var pointer = 0;
                for (var k = 0; k < i; k++) {
                    pointer += items_per_col[k];
                }
                $(this).find('.' + listClass).last().append(items[j + pointer]);
            }
        }
    });
}

// load favorite teachers
function loadFavoriteTeachers(containerHolder) {
    var container = $(containerHolder + ' .teachers .left-col');
    if (userAuthenticated == 1) {
        $(containerHolder + ' .teachers .dropdown').removeClass('lock');
        container.find('ul').remove();
        if (!$.isEmptyObject(userJSON.myFavoriteTeachers)) {
            var list = $('<ul class="favorites">');
            $.each(userJSON.myFavoriteTeachers, function (i) {
                var li = $('<li>');
                var alignLeft = $('<div class="alignleft"><img src="' + userJSON.myFavoriteTeachers[i].teacherPhotoURL + '" width="46" height="53" alt="' + userJSON.myFavoriteTeachers[i].teacherFullName + '" /></div>');
                var textBox = $('<div class="textbox">');
                var name = $('<strong class="name"><a href="' + userJSON.myFavoriteTeachers[i].landingPageURL + '">' + userJSON.myFavoriteTeachers[i].teacherFullName + '</a> <a data-id="' + userJSON.myFavoriteTeachers[i].teacherID + '" href="#" class="remove-teacher-nav" title="Remove from favorites"></a></strong>');
                var records = $('<span>' + userJSON.myFavoriteTeachers[i].teacherShiurimNumber + ' Records</span>');

                alignLeft.appendTo(li);
                name.appendTo(textBox);
                records.appendTo(textBox);
                textBox.appendTo(li);
                li.appendTo(list);
            });

            $(containerHolder + ' .teachers .add-to-message').addClass('hide-element');
            $(list).appendTo(container);

            // Add tooltip
            addTooltip(containerHolder + ' .teachers .left-col .remove-teacher-nav', 'info');

            // remove teacher
            $(containerHolder + ' .teachers .left-col .remove-teacher-nav').on('click', function () {
                var teacherID = $(this).attr('data-id');
                $(this).qtip('destroy', true);
                $(this).parent().parent().parent().fadeOut();
                updateFavorites('remove', 'teacher', teacherID);
                refreshFavorites('remove', teacherID, 'nav');
                return false;
            });
        } else {
            if (containerHolder == '#mobile') {
                $(containerHolder + ' .teachers .add-to-message').html('Add your favorites using button on the teacher landing page.').removeClass('hide-element');
            } else {
                $(containerHolder + ' .teachers .add-to-message').html('Add your favorites using button on the teacher sidebar.').removeClass('hide-element');
            }
        }
    } else {
        $(containerHolder + ' .teachers .dropdown').addClass('lock');
    }
}

// load favorite series
function loadFavoriteSeries(containerHolder) {
    var container = $(containerHolder + ' .series .left-col');
    if (userAuthenticated == 1) {
        $(containerHolder + ' .series .dropdown').removeClass('lock');
        container.find('ul').remove();
        if (!$.isEmptyObject(userJSON.myFavoriteSeries)) {
            var list = $('<ul class="favorites">');
            $.each(userJSON.myFavoriteSeries, function (i) {
                var li = $('<li>');
                var alignLeft = $('<div class="alignleft"><img src="' + userJSON.myFavoriteSeries[i].seriesPhotoURL + '" width="46" height="53" alt="' + userJSON.myFavoriteSeries[i].title + '" /></div>');
                var textBox = $('<div class="textbox">');
                var name = $('<strong class="name"><a href="' + userJSON.myFavoriteSeries[i].landingPageURL + '">' + userJSON.myFavoriteSeries[i].title + '</a> <a data-id="' + userJSON.myFavoriteSeries[i].seriesID + '" href="#" class="remove-series-nav" title="Remove from favorites"></a></strong>');
                var records = $('<span>' + userJSON.myFavoriteSeries[i].seriesShiurimNumber + ' Records</span>');

                alignLeft.appendTo(li);
                name.appendTo(textBox);
                records.appendTo(textBox);
                textBox.appendTo(li);
                li.appendTo(list);
            });

            $(containerHolder + ' .series .add-to-message').addClass('hide-element');
            $(list).appendTo(container);

            // Add tooltip
            addTooltip(containerHolder + ' .series .left-col .remove-series-nav', 'info');

            // remove series
            $(containerHolder + ' .series .left-col .remove-series-nav').unbind();
            $(containerHolder + ' .series .left-col .remove-series-nav').on('click', function () {
                var seriesID = $(this).attr('data-id');
                $(this).qtip('destroy', true);
                $(this).parent().parent().parent().fadeOut();
                updateFavorites('remove', 'series', seriesID);
                refreshFavorites('remove', seriesID, 'nav');
                return false;
            });
        } else {
            if (containerHolder == '#mobile') {
                $(containerHolder + ' .series .add-to-message').html('Add your favorites using button on the series landing page.').removeClass('hide-element');
            } else {
                $(containerHolder + ' .series .add-to-message').html('Add your favorites using button on the series sidebar.').removeClass('hide-element');
            }
        }
    } else {
        $(containerHolder + ' .series .dropdown').addClass('lock');
    }
}

// load favorite venues
function loadFavoriteVenues(containerHolder) {
    var container = $(containerHolder + ' .venues .left-col');
    if (userAuthenticated == 1) {
        $(containerHolder + ' .venues .dropdown').removeClass('lock');
        container.find('ul').remove();
        if (!$.isEmptyObject(userJSON.myFavoriteLocations)) {
            var list = $('<ul class="favorites">');
            $.each(userJSON.myFavoriteLocations, function (i) {
                var li = $('<li>');
                var alignLeft = $('<div class="alignleft"><img src="' + userJSON.myFavoriteLocations[i].locationPhotoURL + '" width="46" height="53" alt="' + userJSON.myFavoriteLocations[i].title + '" /></div>');
                var textBox = $('<div class="textbox">');
                var name = $('<strong class="name"><a href="' + userJSON.myFavoriteLocations[i].landingPageURL + '">' + userJSON.myFavoriteLocations[i].title + '</a> <a data-id="' + userJSON.myFavoriteLocations[i].locationID + '" href="#" class="remove-venues-nav" title="Remove from favorites"></a></strong>');
                var records = $('<span>' + userJSON.myFavoriteLocations[i].locationShiurimNumber + ' Records</span>');

                alignLeft.appendTo(li);
                name.appendTo(textBox);
                records.appendTo(textBox);
                textBox.appendTo(li);
                li.appendTo(list);
            });

            $(containerHolder + ' .venues .add-to-message').addClass('hide-element');
            $(list).appendTo(container);

            // Add tooltip
            addTooltip(containerHolder + ' .venues .left-col .remove-venues-nav', 'info');

            // remove series
            $(containerHolder + ' .venues .left-col .remove-venues-nav').unbind();
            $(containerHolder + ' .venues .left-col .remove-venues-nav').on('click', function () {
                var locationID = $(this).attr('data-id');
                $(this).qtip('destroy', true);
                $(this).parent().parent().parent().fadeOut();
                updateFavorites('remove', 'location', locationID);
                refreshFavorites('remove', locationID, 'nav');
                return false;
            });
        } else {
            if (containerHolder == '#mobile') {
                $(containerHolder + ' .venues .add-to-message').html('Add your favorites using button on the venues landing page.').removeClass('hide-element');
            } else {
                $(containerHolder + ' .venues .add-to-message').html('Add your favorites using button on the venues sidebar.').removeClass('hide-element');
            }
        }
    } else {
        $(containerHolder + ' .venues .dropdown').addClass('lock');
    }
}

// load favorite publications
function loadFavoritePublications(containerHolder) {
    var container = $(containerHolder + ' .publications .left-col');
    if (userAuthenticated == 1) {
        $(containerHolder + ' .publications .dropdown').removeClass('lock');
        container.find('ul').remove();
        if (!$.isEmptyObject(userJSON.myFavoritePublications)) {
            var list = $('<ul class="favorites">');
            $.each(userJSON.myFavoritePublications, function (i) {
                var li = $('<li>');
                var alignLeft = $('<div class="alignleft"><img src="' + userJSON.myFavoritePublications[i].publicationPhotoURL + '" width="46" height="53" alt="' + userJSON.myFavoritePublications[i].title + '" /></div>');
                var textBox = $('<div class="textbox">');
                var name = $('<strong class="name"><a href="' + userJSON.myFavoritePublications[i].landingPageURL + '">' + userJSON.myFavoritePublications[i].title + '</a> <a data-id="' + userJSON.myFavoritePublications[i].publicationID + '" href="#" class="remove-publications-nav" title="Remove from favorites"></a></strong>');
                var records = $('<span>' + userJSON.myFavoritePublications[i].publicationShiurimNumber + ' Records</span>');

                alignLeft.appendTo(li);
                name.appendTo(textBox);
                records.appendTo(textBox);
                textBox.appendTo(li);
                li.appendTo(list);
            });

            $(containerHolder + ' .publications .add-to-message').addClass('hide-element');
            $(list).appendTo(container);

            // Add tooltip
            addTooltip(containerHolder + ' .publications .left-col .remove-publications-nav', 'info');

            // remove series
            $(containerHolder + ' .publications .left-col .remove-publications-nav').unbind();
            $(containerHolder + ' .publications .left-col .remove-publications-nav').on('click', function () {
                var publicationID = $(this).attr('data-id');
                $(this).qtip('destroy', true);
                $(this).parent().parent().parent().fadeOut();
                updateFavorites('remove', 'publication', publicationID);
                refreshFavorites('remove', publicationID, 'nav');
                return false;
            });
        } else {
            if (containerHolder == '#mobile') {
                //$(containerHolder + ' .publications .add-to-message').html('Add your favorites using button on the publications landing page.').removeClass('hide-element');
                $(containerHolder + ' .publications .add-to-message').html('Add your favorites using star button next to Publication name.').removeClass('hide-element');
            } else {
                //$(containerHolder + ' .publications .add-to-message').html('Add your favorites using button on the publications sidebar.').removeClass('hide-element');
                $(containerHolder + ' .publications .add-to-message').html('Add your favorites using star button next to Publication name.').removeClass('hide-element');
            }
        }
    } else {
        $(containerHolder + ' .publications .dropdown').addClass('lock');
    }
}

// add favorites from Nav
function addFavoritesTeachersFromNav() {
    var teacherFavLinks = $('#nav .teachers .teacher-results-holder a.add-to-favorites');
    $.each(teacherFavLinks, function () {
        var item = $(this);
        var teacherID = item.attr('data-id');
        /*var star = $('<a href="#" data-id="'+ teacherID +'" class="add-to-favorites" title="Add to favorites"></a>');
        star.appendTo(item);*/
        if (userAuthenticated == 1) {
            item.on('click', function () {
                if ($(this).hasClass('active')) {
                    updateFavorites('remove', 'teacher', teacherID);
                    refreshFavorites('remove', teacherID, 'nav');
                } else {
                    if (userJSON.myFavoriteTeachers.length <= 4) {
                        updateFavorites('add', 'teacher', teacherID);
                        refreshFavorites('add', teacherID, 'nav');
                    } else {
                        msgAlert('You have reached maximum of 5 Favorite Teachers', 'good');
                    }
                }
                return false;
            });
        } else {
            showLoginPanel(item);
        }
    });
}

function addFavoritesSeriesFromNav() {
    var seriesFavLinks = $('#nav .series .series-results-holder a.add-to-favorites');
    $.each(seriesFavLinks, function () {
        var item = $(this);
        var seriesID = item.attr('data-id');
        /*var star = $('<a href="#" data-id="'+ seriesID +'" class="add-to-favorites" title="Add to favorites"></a>');
        star.appendTo(item);*/
        if (userAuthenticated == 1) {
            item.on('click', function () {
                if ($(this).hasClass('active')) {
                    updateFavorites('remove', 'series', seriesID);
                    refreshFavorites('remove', seriesID, 'nav');
                } else {
                    if (userJSON.myFavoriteSeries.length <= 4) {
                        updateFavorites('add', 'series', seriesID);
                        refreshFavorites('add', seriesID, 'nav');
                    } else {
                        msgAlert('You have reached maximum of 5 Favorite Series', 'good');
                    }
                }
                return false;
            });
        } else {
            showLoginPanel(item);
        }
    });
}

function addFavoritesVenuesFromNav() {
    var venuesFavLinks = $('#nav .venues .venues-results-holder a.add-to-favorites');
    $.each(venuesFavLinks, function () {
        var item = $(this);
        var locationID = item.attr('data-id');
        /*var star = $('<a href="#" data-id="'+ locationID +'" class="add-to-favorites" title="Add to favorites"></a>');
        star.appendTo(item);*/
        if (userAuthenticated == 1) {
            item.on('click', function () {
                if ($(this).hasClass('active')) {
                    updateFavorites('remove', 'location', locationID);
                    refreshFavorites('remove', locationID, 'nav');
                } else {
                    if (userJSON.myFavoriteLocations.length <= 4) {
                        updateFavorites('add', 'location', locationID);
                        refreshFavorites('add', locationID, 'nav');
                    } else {
                        msgAlert('You have reached maximum of 5 Favorite Venues', 'good');
                    }
                }
                return false;
            });
        } else {
            showLoginPanel(item);
        }
    });
}

function addFavoritesPublicationsFromNav() {
    var publicationsFavLinks = $('#nav .publications .publications-results-holder a.add-to-favorites');
    $.each(publicationsFavLinks, function () {
        var item = $(this);
        var publicationID = item.attr('data-id');
        /*var star = $('<a href="#" data-id="'+ locationID +'" class="add-to-favorites" title="Add to favorites"></a>');
        star.appendTo(item);*/
        if (userAuthenticated == 1) {
            item.on('click', function () {
                if ($(this).hasClass('active')) {
                    updateFavorites('remove', 'publication', publicationID);
                    refreshFavorites('remove', publicationID, 'nav');
                } else {
                    if (userJSON.myFavoritePublications.length <= 4) {
                        updateFavorites('add', 'publication', publicationID);
                        refreshFavorites('add', publicationID, 'nav');
                    } else {
                        msgAlert('You have reached maximum of 5 Favorite Publications', 'good');
                    }
                }
                return false;
            });
        } else {
            showLoginPanel(item);
        }
    });
}

// Teacher/Series helper functions
function setColumns(element, elClass, elNumberPerColumn) {
    var item = $(element);
    var numberOfItems;
    if (elClass && elClass != '') {
        numberOfItems = item.find('li.' + elClass).length;
    } else {
        numberOfItems = item.find('li').length;
    }
    var numberPerColumn;
    if (elNumberPerColumn) {
        numberPerColumn = elNumberPerColumn;
    } else {
        numberPerColumn = 18;
    }
    var numberOfColumns = Math.ceil(numberOfItems / numberPerColumn);
    if (numberOfColumns == 0)
        numberOfColumns = 1;
    //make columns
    if (!item.hasClass('column-set')) {
        if (elClass && elClass != '') {
            makeCols(numberOfColumns, item.find('ul'), elClass, '', numberPerColumn);
        } else {
            makeCols(numberOfColumns, item.find('ul'), '', '', numberPerColumn);
        }

        item.addClass('column-set');
    }
}

function setWidth(element, elClass, elNumberPerColumn, callback) {
    var item = $(element);
    var numberOfItems;
    if (elClass && elClass != '') {
        numberOfItems = item.find('li.' + elClass).length;
    } else {
        numberOfItems = item.find('li').length;
    }
    var numberPerColumn;
    if (elNumberPerColumn) {
        numberPerColumn = elNumberPerColumn;
    } else {
        numberPerColumn = 18;
    }

    var numberOfColumns = Math.ceil(numberOfItems / numberPerColumn);
    if (numberOfColumns == 0)
        numberOfColumns = 1;

    var itemWidth = numberOfColumns * 325;
    if (itemWidth < 980) {
        itemWidth = 980;
    }
    item.css('width', itemWidth + 'px');
    if (callback != undefined) {
        callback();
    }
}

function setScroller(element, axis) {
    var item = $(element);
    item.parent().mCustomScrollbar({
        theme: 'minimal-dark', //dark-thin
        scrollInertia: 400,
        axis: axis,
        autoHideScrollbar: false,
        mouseWheel: { axis: axis },
        autoExpandScrollbar: true,
        documentTouchScroll: true,
        advanced: {
            autoScrollOnFocus: false,
            updateOnContentResize: true,
            updateOnBrowserResize: true
        },
        //scrollButtons:{ enable: false },
        callbacks: {
            onInit: function () {
                if (axis == 'x') {
                    $('.nav-slide-prev').hide();
                    $('.nav-slide-next').show();
                }
            },
            onTotalScroll: function () {
                //scrollBackOnce();
                if (axis == 'x') {
                    $('.nav-slide-next').hide();
                }
            },
            /*onUpdate: function(){
              if(axis == 'x'){
                $('.nav-slide-prev').hide();
                $('.nav-slide-next').show();
              }
            },*/
            onTotalScrollBack: function () {
                if (axis == 'x') {
                    $('.nav-slide-prev').hide();
                    $('.nav-slide-next').show();
                }
            },
            onScroll: function () {
                if (axis == 'x') {
                    $('.nav-slide-prev').show();
                    $('.nav-slide-next').show();
                }
            }
        }
    });
}
