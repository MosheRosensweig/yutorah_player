function focusItem(itemValue) {
    var menu = $('#templateSearchBox').data('ui-autocomplete').menu
        , i = 0
        , $items = $('li', menu.element)
        , item
        , text;
    for (; i < $items.length && !item; i++) {
        text = $items.eq(i).find('a').attr('data-value');
        if (itemValue == text) {
            item = $items.eq(i);
        }
    }
    if (item) {
        menu.focus(null, item);
    }
}
function buildAutocomplete() {
    var autoCompleteBox = $('#templateSearchBox')
        .bind("keydown.nav", function (e) {
            if (e.keyCode === $.ui.keyCode.LEFT) {
                e.stopImmediatePropagation();
                var itemValue = $('.search-autocomplete li.aleft:eq(1)').find('a').attr('data-value');
                focusItem(itemValue);
            }
            if (e.keyCode === $.ui.keyCode.RIGHT) {
                e.stopImmediatePropagation();
                var itemValue = $('.search-autocomplete li.aright:eq(1)').find('a').attr('data-value');
                focusItem(itemValue);
            }
        })
        .autocomplete({
            source: function (request, response) {
                $.ajax({
                    /*url: "/_global/customTags/autocomplete.txt",*/
                    url: "/Search/GetSearchBoxSuggestions",
                    dataType: "json",
                    async: true,
                    data: {
                        q: request.term,
                        timestamp: +new Date(),
                        limit: 10
                    },
                    success: function (data) {
                        response(data);
                    }
                });
            },
            minLength: 2,
            select: function (event, ui) {
                if ($(location).attr('href').indexOf('/search/') > -1) {
                    applyFilter(ui.item, $("#templateSearchBox").val());

                    var winWidth = $(window).width();
                    if (winWidth < 1024) {
                        if ($('.form-box').hasClass('active')) {
                            $('.form-box').removeClass('active');
                            $('.form-box').find('.slide').addClass('js-slide-hidden').hide();
                            $('body').removeClass('item-active');
                        }
                    }

                } else {
                    var url = '';
                    url = ui.item.link;
                    window.location.href = url;
                    setTimeout(function () { $("#templateSearchBox").val(''); }, 200);
                }
            },
            focus: function (event, ui) {
            },
            open: function (event, ui) {
                var liNumLeft = $('.search-autocomplete li.aleft').length;
                var liNumRight = $('.search-autocomplete li.aright').length;
                if (liNumLeft > 0 && liNumRight > 0) {
                    var leftHeight = 0;
                    $('.search-autocomplete li.aleft').each(function () {
                        leftHeight += $(this).height();
                    });
                    var rightHeight = 0;
                    $('.search-autocomplete li.aright').each(function () {
                        rightHeight += $(this).height();
                    });
                    var heightVal = leftHeight - rightHeight;
                    var marginTop = Math.abs(heightVal) + 30;
                    $('.search-autocomplete li.aleft').next('li.aright').css('margin-top', marginTop + 'px');
                } else {
                    $('.search-autocomplete').removeClass('search-columns');
                }
            },
            appendTo: '#searchForm',
            position: { my: "left top", at: "left bottom" }
        }).data("ui-autocomplete");

    autoCompleteBox._renderItem = function (ul, item) {
        ul.addClass('search-autocomplete');
        ul.addClass('search-columns');
        var a;
        if (item.type == 'common-search') {
            a = $('<a href="' + item.link + '" data-value="' + item.label + '"><span class="result-count">' + item.count + ' searches</span><span class="text">' + item.label + '</span></a>');
        } else {
            a = $('<a href="' + item.link + '" data-value="' + item.label + '"><span class="text">' + item.label + '</span> ' + '(' + item.count + ')</a>');
        }
        if ($(location).attr('href').indexOf('/search/') > -1) {
            var value = item.label;
            $(a).bind('click', function () {
                $('a.active_filter_item').remove();
                $('#filter_date_uploaded').val("0");
                $('#filter_date').val(0);
                $('#specific_dates_start').val("0");
                $('#specific_dates_end').val("0");
                $('#specific_dates_start_uploaded').val("0");
                $('#specific_dates_end_uploaded').val("0");
                $(amount).attr('max', 90);
                $(amount).attr('min', 0);

                applyFilter(item, value);
                return false;
            });
        } else {
            $(a).bind('click', function () {
                setTimeout(function () { $("#templateSearchBox").val(''); }, 200);
            });
        }

        highlightText(this.term, $(a).find('.text'));

        if (item.type == 'common-search') {
            return $('<li class="aleft"></li>').append(a).appendTo(ul);
        } else {
            return $('<li class="aright"></li>').append(a).appendTo(ul);
        }
    };

    autoCompleteBox._renderMenu = function (ul, items) {
        var that = this,
            currentType = "",
            typeName = "",
            className = "";
        $.each(items, function (index, item) {
            var li;
            if (item.type != currentType) {
                if (item.type == 'common-search') {
                    typeName = 'Common Search';
                    className = 'aleft';
                } else if (item.type == 'category') {
                    typeName = 'Categories';
                    className = 'aright';
                } else if (item.type == 'teacher') {
                    typeName = 'Teachers';
                    className = 'aright';
                } else if (item.type == 'series') {
                    typeName = 'Series';
                    className = 'aright';
                } else if (item.type == 'location') {
                    typeName = 'Venues';
                    className = 'aright';
                }

                if (item.type == 'common-search') {
                    ul.append("<li class='ui-autocomplete-category " + className + "'>" + typeName + "</li>");
                } else {
                    ul.append("<li class='ui-autocomplete-category " + className + "'>" + typeName + " (" + item.total + ")" + "</li>");
                }

                currentType = item.type;
            }

            li = that._renderItemData(ul, item);
            if (item.type) {
                li.attr("aria-label", item.type + " : " + item.label);
            }
        });
    };
    var winWidth = $(window).width();
    var autoCompleteBoxWidth;
    if (winWidth >= 1024) {
        autoCompleteBoxWidth = $('#searchForm').width();
    } else {
        autoCompleteBoxWidth = $('.topbar').width();
    }
    autoCompleteBox._resizeMenu = function () {
        this.menu.element.outerWidth(autoCompleteBoxWidth);
    };
}

jQuery(document).ready(function () {
    buildAutocomplete();
    GetTimelySection();
});

function highlightText(text, $node) {
    var searchText = $.trim(text).toLowerCase(), currentNode = $node.get(0).firstChild, matchIndex, newTextNode, newSpanNode;
    while ((matchIndex = currentNode.data.toLowerCase().indexOf(searchText)) >= 0) {
        newTextNode = currentNode.splitText(matchIndex);
        currentNode = newTextNode.splitText(searchText.length);
        newSpanNode = document.createElement("strong");
        newSpanNode.className = "highlight";
        currentNode.parentNode.insertBefore(newSpanNode, currentNode);
        newSpanNode.appendChild(newTextNode);
    }
}

var applyFilter = function (item, value) {
    $('#userSearchKeywords').children().remove();

    if (item.type != 'common-search') {
        var filterType = '';
        if (item.type == 'category') {
            filterType = 'sub' + item.type + 'id';
        } else {
            filterType = item.type + 'id';
        }

        var aTag = $('<a/>', {
            'href': '#',
            'filter_type': filterType,
            'filter_value': item.id,
            'filter_label': item.label,
            'class': 'filter_item',
            'text': item.label
        });
        activate_filter_item(aTag[0]);

    } else {
        add_search_terms(value);
    }
    setTimeout(function () { $("#templateSearchBox").val(''); }, 200);
};

stateChangedManually = false;
isBackForwardButton = false;
disableHistoryStateChange = false;
//(function (window, undefined) {
//    /* Establish Variables */
//    var State = History.getState(), $log = $('#log');
//    /* Log Initial State */
//    /* History.log('initial:', State.data, State.title, State.url); */
//    /* Bind to State Change */
//    History.Adapter.bind(window, 'statechange', function () { /* Note: We are using statechange instead of popstate */
//        /* Get the State */
//        var State = History.getState(); /* Note: We are using History.getState() instead of event.state */
//        /* Back/Forward button(s) triggered */
//        if (stateChangedManually === false) {
//            isBackForwardButton = true;
//            var shiurID = -1;
//            var shiurATag;
//            if (State.title !== '') {
//                if (State.url != _siteURL + '/') {
//                    if (State.url.indexOf('/sidebar/lecture.cfm/') > -1) {
//                        /* Home Page: Share page -- Show lecture sidebar */
//                        initSharePageLectureSidebar(State.url);
//                    } else if (State.url.indexOf('/sidebar/teacher.cfm/') > -1) {
//                        /* Home Page: Share page -- Show teacher sidebar */
//                        initSharePageTeacherSidebar(State.url);
//                    } else if (State.url.indexOf('/sidebar/category.cfm/') > -1) {
//                        /* Home Page: Share page -- Show category sidebar */
//                        initSharePageCategorySidebar(State.url);
//                    } else if (State.url.indexOf('/sidebar/series.cfm/') > -1) {
//                        /* Home Page: Share page -- Show series sidebar */
//                        initSharePageSeriesSidebar(State.url);
//                    } else if (State.url.indexOf('/sidebar/series.cfm/') > -1) {
//                        /* Home Page: Share page -- Show location sidebar */
//                        initSharePageVenuesSidebar(State.url);
//                    } else if (State.url.indexOf('daf.cfm') > -1) {
//                        var aTagDaf = $('<a/>');
//                        $(aTagDaf).attr('href', State.url);
//                        getDafContent(aTagDaf);
//                    }
//                }
//            } else {
//                /* Daf Page: Reload default content */
//                if (State.url.indexOf('daf.cfm') > -1) {
//                    var aTagDaf = $('<a/>');
//                    $(aTagDaf).attr('href', State.url);
//                    getDafContent(aTagDaf);

//                    /* Home Page: Hide sidebar if visible*/
//                } else {
//                    showHideSidebar();
//                }
//            }
//        }
//        stateChangedManually = false;
//        /* Log the State*/
//        /*History.log('statechange:', State.data, State.title, State.url);*/
//    });
//})(window);

if (jQuery('#close-me').length > 0) {
    jQuery('#close-me').on('click', function () {
        jQuery('#update-browser').remove();
        jQuery('body').removeClass('update-browser-active');
        /* create cookie */
        jQuery.cookie('olderIENotification', 1, { expires: 1, path: '/' });
        return false;
    });
}

//jQuery(document).ready(function () {
//    if (_urlOrganizationID == '301') {
//        set_base_url(searchBaseURL);
//    }
//    set_domain(searchDomain);
//    set_duration_interval(solr_duration_min, Math.min(solr_duration_max, 90));
//    restore_search();
//    set_yutorah_base_url(searchBaseURL);

//    var specific_dates_start = $("#specific_dates_start");
//    var specific_dates_end = $("#specific_dates_end");
//    var filter_date = $("#filter_date");
//    var clear_specific_dates = $("#clear_specific_dates");
//    var specific_dates = $("#specific_dates");
//    var specific_dates_start_uploaded = $("#specific_dates_start_uploaded");
//    var specific_dates_end_uploaded = $("#specific_dates_end_uploaded");
//    var filter_date_uploaded = $("#filter_date_uploaded");
//    var clear_specific_dates_uploaded = $("#clear_specific_dates_uploaded");
//    var specific_dates_uploaded = $("#specific_dates_uploaded");

//    $(clear_specific_dates).click(function () {
//        $(specific_dates_start).val('');
//        $(specific_dates_end).val('');
//        $(specific_dates_start).trigger('change');
//        return false;
//    });
//    $(clear_specific_dates_uploaded).click(function () {
//        $(specific_dates_start_uploaded).val('');
//        $(specific_dates_end_uploaded).val('');
//        $(specific_dates_start_uploaded).trigger('change');
//        return false;
//    });
//    $(filter_date).change(function () {
//        if ($(filter_date).val() == -1) {
//            $(specific_dates).show();
//        } else {
//            $(specific_dates).hide();
//        }
//    });
//    $(filter_date_uploaded).change(function () {
//        if ($(filter_date_uploaded).val() == -1) {
//            $(specific_dates_uploaded).show();
//        } else {
//            $(specific_dates_uploaded).hide();
//        }
//    });
//    /*detect if browser support native date input*/
//    if (!Modernizr.inputtypes.date) {
//        $(specific_dates_start).val($(specific_dates_start).attr('title'));
//        $(specific_dates_end).val($(specific_dates_end).attr('title'));
//        $(specific_dates_start_uploaded).val($(specific_dates_start_uploaded).attr('title'));
//        $(specific_dates_end_uploaded).val($(specific_dates_end_uploaded).attr('title'));
//        $(specific_dates_start).datepicker({
//            changeMonth: true,
//            changeYear: true,
//            showButtonPanel: true,
//            beforeShow: customRange,
//            yearRange: "c-' + yearRange1 + ':c"
//        });
//        $(specific_dates_end).datepicker({
//            changeMonth: true,
//            changeYear: true,
//            showButtonPanel: true,
//            beforeShow: customRange,
//            yearRange: "c-100:c"
//        });
//        $(specific_dates_start_uploaded).datepicker({
//            changeMonth: true,
//            changeYear: true,
//            showButtonPanel: true,
//            beforeShow: customRangeUploaded,
//            yearRange: "c-' + yearRange2 + ':c"
//        });
//        $(specific_dates_end_uploaded).datepicker({
//            changeMonth: true,
//            changeYear: true,
//            showButtonPanel: true,
//            beforeShow: customRangeUploaded,
//            yearRange: "c-100:c"
//        });
//    }
//});
function customRange(input) {
    return {
        minDate: (input.id == "specific_dates_end" ? $("#specific_dates_start").datepicker("getDate") : null),
        maxDate: (input.id == "specific_dates_start" ? $("#specific_dates_end").datepicker("getDate") : null)
    };
}
function customRangeUploaded(input) {
    return {
        minDate: (input.id == "specific_dates_end_uploaded" ? $("#specific_dates_start_uploaded").datepicker("getDate") : null),
        maxDate: (input.id == "specific_dates_start_uploaded" ? $("#specific_dates_end_uploaded").datepicker("getDate") : null)
    };
}
//jQuery(document).ready(function () {
//    if (_urlOrganizationID == '301') {
//        set_base_url(searchBaseURL);
//    }
//    set_domain(searchDomain);
//    set_duration_interval(solr_duration_min, Math.min(solr_duration_max, 90));
//    restore_search();
//    set_yutorah_base_url(searchBaseURL);
//});

jQuery(document).ready(function () {

    $('#getLink').on('click', function () {
        $('#get-link-container').toggleClass('hide-element');
        $('#thisLink').select();
        return false;
    });
    $('#thisLink').on('click', function () {
        $(this).select();
    });
});

jQuery(document).ready(function () {
    $('#userSignupForm').attr('autocomplete', 'off');
    $('#userFirstName').attr('autocomplete', 'off');
    $('#userLastName').attr('autocomplete', 'off');
    $('#username').attr('autocomplete', 'off');
    $('#userEmail').attr('autocomplete', 'off');
    $('#userPassword1').attr('autocomplete', 'off');
    $('#userPassword2').attr('autocomplete', 'off');
    $('#userBirthYear').attr('autocomplete', 'off');
    $('#userCity').attr('autocomplete', 'off');
    $('#userState').attr('autocomplete', 'off');
    $('#userCountry').attr('autocomplete', 'off');
});

async function GetTimelySection() {
    var timelyDataURL = 'https://api.yutorah.org/homepage/timely';

    var timelyData = await fetch(timelyDataURL);
    timelyData = await timelyData.json();

    // timely
    var jsonSubset = new Object();
    jsonSubset.parshaStr = timelyData.parshaStr;
    jsonSubset.parshaURL = timelyData.parshaURL + '/';
    jsonSubset.dafStr = timelyData.dafStr;
    jsonSubset.mishnaYomiStr = timelyData.mishnaYomiStr;
    jsonSubset.mishnaYomiSubcategoryID = timelyData.mishnaYomiSubcategoryID;
    jsonSubset.nachYomiStr = timelyData.nachYomiStr;
    jsonSubset.nachYomiSubcategoryID = timelyData.nachYomiSubcategoryID;

    // shiur count
    jsonSubset.totalShiurCount = await fetchTotalShiurim(0);

    // top black bar
    $.get('/partials/header-topbar.html', function (data) {
        var templateSource_headerTopbar = data;
        var templateHeaderTopbar = Handlebars.compile(templateSource_headerTopbar);
        var newHTML1 = templateHeaderTopbar(jsonSubset);

        $('#header #header-topbar-toreplace').html(newHTML1);
    });

}