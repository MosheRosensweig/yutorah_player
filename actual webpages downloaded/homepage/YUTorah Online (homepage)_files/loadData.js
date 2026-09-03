
//
// handlebar helpers
//

var previousCategoryName = "";
Handlebars.registerHelper('formatCategoryName', function (value) {
    var str = "";
    if (previousCategoryName != value) {
        previousCategoryName = value;
        return value + ': ';
    }
    else {
        return ",";    //// really want to group by category and then put subcategory comma-delimited on same line
    }
});


Handlebars.registerHelper('stringify', function (object) {
    return JSON.stringify(object);
});


Handlebars.registerHelper('replaceSpecialCharacters', function (value) {
    return value?.replaceAll(' ', '-');   /// remove ALL special characters
});

Handlebars.registerHelper('isSameCategory', function (value1, value2, options) {
    if (value1 === value2) {
        return options.fn(this);
    } else {
        return '';
    }
});

// Helper method to check if a category group starts
Handlebars.registerHelper('isCategoryGroupStart', function (categoryShortName, prevCategoryShortName, options) {
    return categoryShortName !== prevCategoryShortName ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('not', function (value) {
    return !value;
});

Handlebars.registerHelper('isEqual', function (value1, value2, options) {
    if (value1 === value2) {
        return options.fn(this);
    } else {
        return options.inverse(this);
    }
});

Handlebars.registerHelper('setPrevCategoryShortName', function (value) {
    this.prevCategoryShortName = value;
});


Handlebars.registerHelper('formatDate', function (value) {

    //return $.format.date(value, 'MMM dd, yyyy');
    //return "date string";
    //return moment(value).format("ll");

    var thisDate = new Date(value);
    thisDate.setHours(0, 0, 0, 0);

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    if (thisDate.getTime() == today.getTime())
        return 'Today';
    else if (thisDate.getTime() == yesterday.getTime())
        return 'Yesterday';
    else {
        //return thisDate.toTimeString("mmm");
        return $.format.date(thisDate, 'MMM dd, yy');
    }
});

Handlebars.registerHelper('formatDate_minutesAgo', function (value) {

    var today = new Date();
    var thisDate = new Date(value);

    var diff = today - thisDate;

    return "y" + diff;


});

Handlebars.registerHelper('formatTime', function (value) {

    var str = "";
    var parts = value.split(':');

    // if not X:X:X
    if (parts.length != 3) {
        console.log('Time format not X:X:X');
        return "";
    }

    //if time negative like -693595.00:00:00
    if (parts[0] < 0) {
        console.log('Time negative');
        return "";
    }

    if (parts[0] != "00") {
        if (parts[0][0] == '0')
            str = str + parts[0][1] + " hr ";
        else
            str = str + parts[0] + " hr ";
    }

    if (parts[1][0] == '0')
        str = str + parts[1][1] + " min";
    else
        str = str + parts[1] + " min";

    return str;
});

// ABOUT: Load js scripts dynamically
function loadScript(url, callback) {
    var script = document.createElement('script');
    script.src = url;

    script.onload = function () {
        if (typeof callback === 'function') {
            callback();
        }
    };
    document.head.appendChild(script);
} 
 loadScript('/js/utils/shiurim-count.utils.js');

//
// on page load,
// load data dynamically
//

$(document).ready(() => {
    renderPageElements();
});

async function renderPageElements() {

    // log time
    var now1 = new Date();
    var ticks1 = now1.getTime();

    // get home page data from server
    var homeDataURL = 'https://api.yutorah.org/homepage/details'; // window.env?.toLowerCase() == 'production' ? 'https://api4.yutorah.org/homepage/details' : 'https://localhost:7074/homepage/details';
    //var homeDataURL = 'https://localhost:7074/homepage/details';

    var homepageData = await fetch(homeDataURL);
    homepageData = await homepageData.json();

    var now2 = new Date();
    var ticks2 = now2.getTime();

    console.log('homepage fetch: ' + (ticks2 - ticks1));

    // timely
    var jsonSubset = new Object();
    jsonSubset.parshaStr = homepageData.timelyData.parshaStr;
    jsonSubset.parshaURL = homepageData.timelyData.parshaURL + '/';
    jsonSubset.dafStr = homepageData.timelyData.dafStr;
    jsonSubset.mishnaYomiStr = homepageData.timelyData.mishnaYomiStr;
    jsonSubset.mishnaYomiSubcategoryID = homepageData.timelyData.mishnaYomiSubcategoryID;
    jsonSubset.nachYomiStr = homepageData.timelyData.nachYomiStr;
    jsonSubset.nachYomiSubcategoryID = homepageData.timelyData.nachYomiSubcategoryID;

    // shiur count
    jsonSubset.totalShiurCount = await fetchTotalShiurim(homepageData.totalShiurCount);

    $('#templateSearchBox').attr("placeholder", "Search through " + jsonSubset.totalShiurCount + " shiurim...");

    // hebrew date
    jsonSubset.hebrewDateString = homepageData.hebrewDateString;

    // timely section
    $.get('/partials/timelySection.html', function (data) {
        var templateSource_timelySection = data;
        var templateHeaderTimelySection = Handlebars.compile(templateSource_timelySection);
        var newHTML2 = templateHeaderTimelySection(jsonSubset);
        $('#timelySection').html(newHTML2);
    });

    initSlideShow();

    // carousel
    $.get('/partials/carousel.html', function (data) {
        var templateSource_carousel = data;
        var template_carousel = Handlebars.compile(templateSource_carousel);

        $.each(homepageData.carousel, function (index, item) {
            item.targetURL = encodeURIComponent(item.targetURL);
        })

        createCarouselHTML(homepageData.carousel, '#carouselToReplace', 0, homepageData.carousel.length + 1);

        function createCarouselHTML(jsonData, htmlElement, from, to) {
            var jsonSubset = new Object();
            jsonSubset.carousel = JSON.parse(JSON.stringify(jsonData.slice(from, to)));

            var newHTML = template_carousel(jsonSubset);
            $(htmlElement).html(newHTML);

            initCarousel();

        }
    });


    // editors picks


    $.get('/partials/featuredShiurim.html', function (data) {

        var templateSourceFeatured = data;
        var templateFeatured = Handlebars.compile(templateSourceFeatured);

        createHTML(homepageData.editorsPicks, '#tab5 #leftcolumn', 0, 5);
        createHTML(homepageData.editorsPicks, '#tab5 #rightcolumn', 5, 10);

        createHTML(homepageData.recentlyUploaded, '#tab7 #leftcolumn', 0, 5);
        createHTML(homepageData.recentlyUploaded, '#tab7 #rightcolumn', 5, 10);

        createHTML(homepageData.recentlyViewed, '#tab9 #leftcolumn', 0, 5);
        createHTML(homepageData.recentlyViewed, '#tab9 #rightcolumn', 5, 10);

        createHTML(homepageData.parshaShiurim, '#tab10 #leftcolumn', 0, 5);
        createHTML(homepageData.parshaShiurim, '#tab10 #rightcolumn', 5, 10);

        createHTML(homepageData.dailyShiurim, '#tab11 #leftcolumn', 0, 5);
        createHTML(homepageData.dailyShiurim, '#tab11 #rightcolumn', 5, 10);

        function createHTML(jsonData, htmlElement, from, to) {
            var jsonSubset = new Object();
            jsonSubset.shiurim = JSON.parse(JSON.stringify(jsonData.slice(from, to)));

            var newHTML = templateFeatured(jsonSubset);
            $(htmlElement).html(newHTML);
        }

        var now2 = new Date();
        var ticks2 = now2.getTime();

        initFeaturedButtons('#home-tabs-area #tab5 .post');
        initFeaturedButtons('.daf-related .post');
        initFeaturedButtons('.lecture-buttons');
        initFeaturedButtons('.lecture-page .tab-holder .list .post');

        console.log('Editors picks render: ' + (ticks2 - ticks1));
    });



    // featured series
    $.get('/partials/featuredSeries.html', function (data) {

        var templateSourceFeaturedSeries = data;
        var templateFeaturedSeries = Handlebars.compile(templateSourceFeaturedSeries);

        createHTMLFeaturedSeries(homepageData.featuredSeries, '#tab6 #leftcolumn', 0, 5);
        createHTMLFeaturedSeries(homepageData.featuredSeries, '#tab6 #rightcolumn', 5, 10);

        function createHTMLFeaturedSeries(jsonData, htmlElement, from, to) {
            var jsonSubset = new Object();
            jsonSubset.featuredSeries = JSON.parse(JSON.stringify(jsonData.slice(from, to)));

            var newHTML = templateFeaturedSeries(jsonSubset);
            $(htmlElement).html(newHTML);
        }

    });

    var now3 = new Date();
    var ticks3 = now3.getTime();

    $.get('/Home/GetTopBanner', function (topBanner) {
        $.get('/partials/topBanner.html', function (data) {

            if (topBanner == null) {
                return;
            }
            var templateTopAdd = Handlebars.compile(data);

            var newHTML = templateTopAdd(topBanner);
            $(".top-ad.first").html(newHTML);
            if (topBanner != null && topBanner.sbURL != "") {
                //$(".nav1").css("margin-top", "90px");
            }

        });
    });

    $.get('/Home/GetSideBanners', function (sideBanners) {
        $.get('/partials/sideBanners.html', function (data) {

            console.log(sideBanners);
            var templateSideAdd = Handlebars.compile(data);

            var newHTML = templateSideAdd(sideBanners);
            var html = $("#sidebar").html();
            //$("#sidebar").html(newHTML + html);
            $(newHTML).prependTo("#sidebar");

        });
    });
}
