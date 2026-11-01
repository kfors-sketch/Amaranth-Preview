(function () {
  "use strict";
  const tokenKey = "amaranth_report_token";
  const loginPath = "/admin/reporting_login.html";
  const token = localStorage.getItem(tokenKey) || "";
  function redirectToLogin() {
    localStorage.removeItem(tokenKey);
    location.replace(loginPath);
  }
  if (!token) {
    redirectToLogin();
    return;
  }
  fetch("/api/router?type=debug_token", {
    cache: "no-store",
    headers: { Authorization: "Bearer " + token },
  }).then((response) => {
    if (response.status === 401 || response.status === 403) redirectToLogin();
  }).catch(() => {
    // A temporary network error is not proof that the session expired.
  });
})();

