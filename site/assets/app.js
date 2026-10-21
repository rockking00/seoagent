/* 整站唯一的 JS，约 1KB。不依赖任何框架。 */
(() => {
  // 顶栏滚动描边
  const header = document.querySelector('.site-header');
  if (header) {
    const sync = () => header.classList.toggle('is-stuck', window.scrollY > 6);
    sync();
    window.addEventListener('scroll', sync, { passive: true });
  }

  // 页脚年份
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // 长文页的阅读进度条
  const progress = document.querySelector('.reading-progress span');
  if (progress) {
    const update = () => {
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      progress.style.transform = `scaleX(${max > 0 ? Math.min(1, el.scrollTop / max) : 0})`;
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }

  // 长文页：目录跟随当前章节高亮
  const tocLinks = Array.from(document.querySelectorAll('.toc a[href^="#"]'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const bySection = new Map();
    for (const link of tocLinks) {
      const section = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (section) bySection.set(section, link);
    }

    if (bySection.size) {
      const activate = (link) => {
        for (const item of tocLinks) item.classList.toggle('is-active', item === link);
      };

      // 页面刚打开时还没有章节进入判定区，先把第一条标上
      activate(tocLinks[0]);

      const io = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible.length) activate(bySection.get(visible[0].target));
        },
        { rootMargin: '-100px 0px -62% 0px', threshold: 0 }
      );

      bySection.forEach((_, section) => io.observe(section));

      // 滚到底时最后一节可能永远进不了判定区，单独兜一下
      window.addEventListener(
        'scroll',
        () => {
          const doc = document.documentElement;
          if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
            activate(tocLinks[tocLinks.length - 1]);
          }
        },
        { passive: true }
      );
    }
  }

  // 入场动画：JS 不可用 / 用户偏好减少动态时，内容直接可见
  const targets = document.querySelectorAll('[data-reveal]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (targets.length && !reduce && 'IntersectionObserver' in window) {
    targets.forEach((el) => el.classList.add('reveal'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
    );
    targets.forEach((el) => io.observe(el));
  }

  // 表单：时间陷阱 + 记录来源
  const form = document.querySelector('.form-card');
  if (form) {
    const t = form.querySelector('input[name="_t"]');
    if (t) t.value = String(Date.now());

    const ref = form.querySelector('input[name="_ref"]');
    if (ref) {
      const params = new URLSearchParams(location.search);
      const utm = ['utm_source', 'utm_medium', 'utm_campaign']
        .map((k) => params.get(k))
        .filter(Boolean)
        .join('/');
      let from = '';
      if (document.referrer) {
        try {
          from = new URL(document.referrer).hostname;
        } catch {
          from = '';
        }
      }
      ref.value = [from, utm].filter(Boolean).join(' | ').slice(0, 300);
    }
  }
})();
