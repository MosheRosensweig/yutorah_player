$(function(){
  if((typeof bHtmlText != 'undefined') && (bHtmlText != '')){
    $("#notification-container").notify()
    .notify("create",
      "themeroller",
      { 
        /*title:'Warning1',*/
        text: bHtmlText
      },
      {
        custom: true,
        expires: false,
        close: function(){
          /* remove class from body tag */
          $('body').removeClass('popup-active');
          set_notification_closed(bID);
        }
      }
    );
  }
  var set_notification_closed = function(id) {
    $.post('/_notification_closed.cfm', { 'notification_id': id });
  }
});