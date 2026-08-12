document.addEventListener('DOMContentLoaded', function () {
  /* ---------- 滚动入场动效 ---------- */
  const faders = document.querySelectorAll('.fade-in');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('visible');
          observer.unobserve(entry.target); // 只播一次
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px',
      }
    );

    faders.forEach((el) => observer.observe(el));
  } else {
    // 老浏览器直接显示，避免内容永远透明
    faders.forEach((el) => el.classList.add('visible'));
  }

  /* 同一组卡片依次入场，而不是整排一起跳出来 */
  document.querySelectorAll('.features-grid, .languages-grid, .download-grid').forEach((grid) => {
    Array.from(grid.children).forEach((card, i) => {
      if (card.classList.contains('fade-in')) {
        card.style.transitionDelay = Math.min(i * 70, 350) + 'ms';
      }
    });
  });

  /* ---------- 导航滚动态 ---------- */
  const nav = document.querySelector('nav');

  if (nav) {
    const syncNavState = () => {
      nav.classList.toggle('scrolled', window.scrollY > 8);
    };

    syncNavState();
    window.addEventListener('scroll', syncNavState, { passive: true });

    /* ---------- 移动端菜单 ---------- */
    const menuBtn = nav.querySelector('.mobile-menu-btn');
    const navLinks = nav.querySelector('.nav-links');

    if (menuBtn && navLinks) {
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-controls', 'nav-links');
      navLinks.id = navLinks.id || 'nav-links';

      const setMenu = (open) => {
        nav.classList.toggle('nav-open', open);
        menuBtn.setAttribute('aria-expanded', String(open));
      };

      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setMenu(!nav.classList.contains('nav-open'));
      });

      // 点链接后收起
      navLinks.addEventListener('click', (e) => {
        if (e.target.closest('a')) setMenu(false);
      });

      // 点空白处 / 按 Esc 收起
      document.addEventListener('click', (e) => {
        if (!nav.contains(e.target)) setMenu(false);
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setMenu(false);
      });
    }
  }
});
