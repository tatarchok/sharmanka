// SoundCloud Interface Plugin (Sanitized for Music Hub)
(function() {
  function cleanupOldButtons() {
    try {
      document.querySelectorAll(
        '.header__appnextbtn, .header__apppreviousbtn, .header__appclosebtn, ' +
        '.header__appmaximizebtn, .header__appminimizebtn, .playControls__pluginbtn, ' +
        '.playControls__themebtn, .playControls__lyricbtn, .playControls__showcasebtn'
      ).forEach(el => el.remove());
    } catch(e) {}
  }

  cleanupOldButtons();
})();
