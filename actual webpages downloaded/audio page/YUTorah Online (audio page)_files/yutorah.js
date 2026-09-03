function showDesc(id) {
	var desc = document.getElementById('description_' + id).style.display;
	if (desc == "none") {
		document.getElementById('description_' + id).style.display = "block";
		document.getElementById('arrow_right_' + id).style.display = "none";
		document.getElementById('arrow_down_' + id).style.display = "block";
	}
	else {
		document.getElementById('description_' + id).style.display = "none";
		document.getElementById('arrow_right_' + id).style.display = "block";
		document.getElementById('arrow_down_' + id).style.display = "none";
	}
}

function OpenLogin(windowURL) {
	if (document.all) {
		currentModelessDialog = window.showModelessDialog(windowURL, window, "dialogHeight: 180px; dialogWidth: 350px; dialogTop: 150px; dialogLeft: 150px; edge: Sunken; center: Yes; help: Yes; resizable: Yes; status: No;");
	}
	else {
		window.open(windowURL);
	}
}


function openAddWindow() {
	eW = window.open('/admin/shiur_edit.cfm?mode=add', 'adminWin', 'width=950,height=750,resizable=1,scrollbars=1');
	eW.focus();
}

function openAddNewWindow(userId) {
	eW = window.open('https://uploader.yutorah.org?token=' + userId, 'adminWin');
	eW.focus();
}


var openShiurimEditorsWindow = function () {
	eW = window.open('/admin/shiurimEditors/shiurimEditors.cfm', 'adminWin', 'width=920, height=740, resizable=no, scrollbars=no');
	eW.focus();
}


function openAdmin(thisShiurID) {
	openPortalAdmin(userId, thisShiurID);
}

function openPortalAdmin(thisUserId, thisShiurID) {
	//eW = window.open('/admin/shiur_edit.cfm?mode=edit&shiurID='+thisShiurID,'adminWin','width=623,height=500');
	eW = window.open('https://uploader.yutorah.org?token=' + thisUserId + '&shiurId=' + thisShiurID, 'adminWin');
	eW.focus();
}

function ieupdate(someDocument) {
	var strBrowser = navigator.userAgent.toLowerCase();
	if (strBrowser.indexOf("msie") > -1 && strBrowser.indexOf("mac") < 0) {
		var theObjects = someDocument.getElementsByTagName('object');
		var theObjectsLen = theObjects.length;
		for (var i = 0; i < theObjectsLen; i++) {
			if (theObjects[i].outerHTML) {
				if (theObjects[i].data) {
					theObjects[i].removeAttribute('data');
				}
				var theParams = theObjects[i].getElementsByTagName("param");
				var theParamsLength = theParams.length;
				for (var j = 0; j < theParamsLength; j++) {
					if (theParams[j].name.toLowerCase() == 'flashvars') {
						var theFlashVars = theParams[j].value;
					}
				}
				var theOuterHTML = theObjects[i].outerHTML;
				var re = /<param name="FlashVars" value="">/ig;
				theOuterHTML = theOuterHTML.replace(re, "<param name='FlashVars' value='" + theFlashVars + "'>");
				theObjects[i].outerHTML = theOuterHTML;
			}
		}
	}
}

function setCookie(c_name, expDays, update) {

	value = document.getElementById(update + 'RecordPerPage').value;
	jQuery.cookie(c_name, escape(value), { expires: expDays, path: '/' });

	//var exdate = new Date();
	//exdate.setDate(exdate.getDate() + expdays);
	//document.cookie = c_name + '=' + escape(value) + ((expdays == null) ? '' : ';expires=' + exdate.toGMTString());

	if (update == 'browse') {
		updateBrowseResults();
	}
	/*
	if(update == 'search'){
		alert(update);	
	}
	*/
}