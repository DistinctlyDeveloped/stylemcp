// StyleMCP Shared Auth - Include on all pages
(function() {
  const SUPABASE_URL = 'https://orbliwjewqlnnutykozw.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yYmxpd2pld3Fsbm51dHlrb3p3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNzE5MTEsImV4cCI6MjA4NDg0NzkxMX0.z2xrGw-3UqOHTQ28g7b83vBsavt9rDDP61MKo9I_ZSQ';
  
  // Wait for Supabase to load
  function initAuth() {
    if (!window.supabase) {
      setTimeout(initAuth, 100);
      return;
    }
    
    // Use existing client if already created, or create new one
    if (window.sbClient) {
      // Already initialized
      return;
    }
    
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    window.sbClient = sb;  // Global shared client
    window.styleMCPAuth = sb;
    
    // Check session and update nav
    sb.auth.getSession().then(({ data: { session } }) => {
      updateNav(session);
      
      // If on login/signup page and already logged in, redirect to dashboard
      const path = window.location.pathname;
      if (session && (path.includes('login') || path.includes('signup'))) {
        window.location.href = '/dashboard.html';
      }
    });
    
    // Listen for auth changes
    sb.auth.onAuthStateChange((event, session) => {
      console.log('Auth state changed:', event);
      updateNav(session);
    });
  }
  
  function updateNav(session) {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;
    
    // Find login link and CTA
    const loginLink = navLinks.querySelector('a[href*="login"]');
    const ctaLink = navLinks.querySelector('.nav-cta');
    
    if (session) {
      // User is logged in - show Dashboard link
      if (loginLink) {
        loginLink.href = '/dashboard.html';
        loginLink.textContent = 'Dashboard';
        loginLink.classList.remove('active');
      }
      if (ctaLink) {
        ctaLink.href = '/dashboard.html';
        ctaLink.textContent = 'Dashboard';
        ctaLink.classList.remove('active');
      }
    } else {
      // User is not logged in - show Login and Get Started
      if (loginLink) {
        loginLink.href = '/login.html';
        loginLink.textContent = 'Login';
      }
      if (ctaLink) {
        ctaLink.href = '/signup.html';
        ctaLink.textContent = 'Get Started';
      }
    }
  }
  
  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }
})();
