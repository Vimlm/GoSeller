// Runs in the page's "world", BEFORE the WA-JS library.
// Turns off Google analytics and the library's "powered by" signature.
window.WPPConfig = {
  disableGoogleAnalytics: true,
  googleAnalyticsId: null,
  poweredBy: null,
  deviceName: false,
  sendStatusToDevice: false,
};
