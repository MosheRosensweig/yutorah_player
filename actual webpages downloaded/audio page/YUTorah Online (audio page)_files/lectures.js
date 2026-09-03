jQuery(document).ready(function(){
    addTooltip('.btn-comment-disabled', 'info');
    addTooltip('.reply-disabled', 'info');
    showLoginPanel('.btn-comment-disabled');
    showLoginPanel('.reply-disabled');
});

var leaveCommentFormValidator;

var leaveComment = function(commentID) {
    if ($('#leaveCommentForm').length > 0) {
        if (commentID == '') {
            $('#commentReplyToCommentID').val('');
        } else {
            $('#commentReplyToCommentID').val(commentID);
        }
        $('#leaveCommentForm').show();
        setTimeout(function() {
            $('#commentTitle').focus();
        }, 200);
        /* scroll to comment form */
        /*$('body, #wrap-holder').animate({
            scrollTop: $('#leaveCommentForm').offset().top
        }, 400);*/
		$('body, #wrap-holder').scrollTo('#leaveCommentForm');
    }
};

var hideCommentForm = function() {
    if ($('#leaveCommentForm').length > 0) {
        $('#commentTitle').val('');
        $('#commentText').val('');
        $('#commentReplyToCommentID').val('');
        $('#leaveCommentForm').hide();
    }
};

var initleaveCommentFormValidator = function() {
    $('#commentTitle').attr('autocomplete', 'off');

    if ($('#addLectureCommentForm').length > 0) {
        var rules = {
            'commentTitle': {
                'required': true
            },
            'commentText': {
                'required': true
            }
        };

        var options = {
            'errorClass': 'error',
            'rules': rules,
            errorPlacement: function(error, element) {
                $(element).after(error);
            },
            submitHandler: function(form) {
                var isSubmitted = false;

                tinyMCE.triggerSave();

                if (!isSubmitted) {
                    isSubmitted = true;

                    $.ajax({
                        url: form.action,
                        type: form.method,
                        data: $(form).serialize(),
                        dataType: 'json',
                        success: function(response) {
                            $('#leaveCommentForm').hide();

                            leaveCommentFormValidator.resetForm();
                            leaveCommentFormValidator.reset();
                            leaveCommentFormValidator.submitted = {};
                            leaveCommentFormValidator.prepareForm();
                            leaveCommentFormValidator.hideErrors();

                            $('#commentTitle').val('');
                            $('#commentText').val('');
                            $('#commentAnonymous').attr('checked', false);

                            var textareaID = 'commentText';
                            tinyMCE.get(textareaID).setContent(''); 											

                            if (response['message'] != '') {
                                if (!response['isError']) {
                                    if ($('#lectureCommentsHTML').length > 0) {
                                        $('#lectureCommentsHTML').replaceWith(response['commentsHTML']);
                                    } else {
                                        $('#leaveCommentForm').after(response['commentsHTML']);
                                    }

                                    var commentsNum = response['commentsNumber'] + ' comment';
                                    if (parseInt(response['commentsNumber']) > 1) {
                                        commentsNum += 's';
                                    }
                                    $('#content .lecture-page .comment-area .comment-head span.comments').html(commentsNum);
                                    $('#content .profile-section .profile-info dt.comments').next().html(response['commentsNumber']);

                                    msgAlert(response['message'], 'good');
                                } else {
                                    msgAlert(response['message'], 'error');
                                }
                            }

                            isSubmitted = false;
                        },
                        error: function(jqXHR, exception) {
                            errorHandler(jqXHR, exception);
                        }
                    }).done(
                        function(){
                            isSubmitted = false; 
                            if (typeof console != 'undefined') {

                            }
                        }).fail(function(){
                            if (typeof console != 'undefined') { 

                            }
                        });      
                }
            }      
        };
        leaveCommentFormValidator = $("#addLectureCommentForm").validate(options);
    }
};

var deleteComment = function(commentID) {
    var commentShiurID = lectureShiurID;

    if ((commentShiurID != '') && (commentID != '')) {
        var isSubmitted = false;

        var r = confirm('Are you sure you want to delete this comment?');
        if (r == true) {
            if (!isSubmitted) {
                isSubmitted = true;

                var params = {
                    'commentShiurID': commentShiurID,
                    'commentID': commentID
                };
                $.ajax({
                    url: _siteURL + '/lectures/deleteComment_process.cfm',
                    type: 'post',
                    data: params,
                    dataType: 'json',
                    success: function(response) {
                        if (response['message'] != '') {
                            if (!response['isError']) {
                                if ($('#lectureCommentsHTML').length > 0) {
                                    $('#lectureCommentsHTML').replaceWith(response['commentsHTML']);
                                } else {
                                    $('#leaveCommentForm').after(response['commentsHTML']);
                                }

                                var commentsNum = response['commentsNumber'] + ' comment';
                                if (parseInt(response['commentsNumber']) > 1) {
                                    commentsNum += 's';
                                }
                                $('#content .lecture-page .comment-area .comment-head span.comments').html(commentsNum);
                                $('#content .profile-section .profile-info dt.comments').next().html(response['commentsNumber']);

                                msgAlert(response['message'], 'good');
                            } else {
                                msgAlert(response['message'], 'error');
                            }
                        }

                        isSubmitted = false;
                    },
                    error: function(jqXHR, exception) {
                        errorHandler(jqXHR, exception);
                    }
                }).done(
                    function(){
                        isSubmitted = false; 
                        if (typeof console != 'undefined') {

                        }
                    }).fail(function(){
                        if (typeof console != 'undefined') { 

                        }
                    });      
            }
        }						

    } else {
        msgAlert('Something went wrong. Please try again.', 'error');
    }
};

var errorHandler = function(jqXHR, exception) {
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
};

initleaveCommentFormValidator();

/*Audio player START*/
	jQuery(document).ready(function(){
		$('.lecture-page .social-networks li a').on('click', function(){
			
		});
		addTooltip('.lecture-page .ask-teacher', 'info', 'center', 'right', 'center', 'left');
		showLoginPanel('.lecture-page .ask-teacher');
		
		if($('#jp_container_lecture').length > 0){
			if(sessionStorage.getItem('playingShiurID') === null){
				/*ajaxLoadContent('/sidebar/getLectureDataJSON.cfm?shiurID=' + activeLectureID, 'json', false, function (data) {
					initSidePlayer(data, 'lecture', $('#jp_container_lecture').attr('data-time'));
					sessionStorage.setItem('playingShiurID', data.shiurID);
					playerCalled = true;
				});*/
              initSidePlayer(lecturePlayerData, 'lecture', $('#jp_container_lecture').attr('data-time'));
              sessionStorage.setItem('playingShiurID', lecturePlayerData.shiurID);
              playerCalled = true;
			} else {
				if(sessionStorage.getItem('playingShiurID') != activeLectureID){
					sessionStorage.removeItem('playingShiurID');
					sessionStorage.removeItem('currentTime');
					/*ajaxLoadContent('/sidebar/getLectureDataJSON.cfm?shiurID=' + activeLectureID, 'json', false, function (data) {
						initSidePlayer(data, 'lecture', $('#jp_container_lecture').attr('data-time'));
						sessionStorage.setItem('playingShiurID', data.shiurID);
						playerCalled = true;
					});*/
                    initSidePlayer(lecturePlayerData, 'lecture', $('#jp_container_lecture').attr('data-time'));
                    sessionStorage.setItem('playingShiurID', lecturePlayerData.shiurID);
                    playerCalled = true;
				}
			}
		}
	});
/*Audio player END*/

/*Additional Materials START*/
	var tabs = $("#tabs-pdf-viewer");
	if(tabs.length > 0){
		var dialogWin = $("#dialog-pdf-viewer");
		var counter = 1;
		var activeTab = 0;

		function showModalBox(contentURL, contentTitle){
			var alreadyExsist = 0;
			
			$('#tabs-pdf-viewer ul li').each(function(){
				var item = $(this).find('a');
				if(item.html() == contentTitle){
					alreadyExsist++;
				}
			});

			if(alreadyExsist == 0){
				var newFileLi = $('<li><a href="#tabs-' + counter + '">' + contentTitle + '</a></li>');
				newFileLi.appendTo($('#tabs-pdf-viewer ul'));
				var newFileContent = $('<div id="tabs-' + counter + '"><iframe class="pdf-embed-file" src="' + _cdnPublicURL + 'js/pdf/web/viewer.html?file=' + contentURL + '" border="0"></iframe></div>');
				newFileContent.appendTo($('#tabs-pdf-viewer'));
				counter++;
				activeTab++;
			}
			
			tabs.tabs();
			tabs.tabs('refresh');
			tabs.tabs({
			  active: activeTab
			});

			dialogWin.dialog({
				modal: false, //if true then overlay
				resizable: true,
				maxWidth: 1024,
				width: 800,
				height: 700,
				position: { 
					my: "center",
					at: "center top",
					of: $('#main')
				},
				title: 'Additional Materials Viewer'
			});
		}
	}
/*Additional Materials END*/

/*Subscribe popup START*/
/*jQuery(document).ready(function($) {
    jQuery.get('/subscribe/Subscription_new_ajax.cfm', function(data) {		
        jQuery('#displaybox').css('display', 'block');				
        jQuery('#subscrpop').html(data).css('display', 'block');
        addTwit();
    });
});*/
/*Subscribe popup END*/