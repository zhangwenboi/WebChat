export function hideScriptUiForPicking({ panelEl, root = document } = {}) {
    const entries = [];
    const hide = (el, mode) => {
        if (!el) return;
        entries.push({
            el,
            mode,
            className: el.className,
            display: el.style.display,
            pointerEvents: el.style.pointerEvents,
            ariaHidden: el.getAttribute('aria-hidden')
        });
        if (mode === 'panel') {
            el.classList.add('webchat-script-panel-hidden');
        } else {
            el.style.display = 'none';
            el.style.pointerEvents = 'none';
            el.setAttribute('aria-hidden', 'true');
        }
    };

    if (panelEl) hide(panelEl, 'panel');
    const modals = root.querySelectorAll('.webchat-script-modal');
    for (const modal of modals) hide(modal, 'modal');

    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        for (const entry of entries.reverse()) {
            entry.el.className = entry.className;
            entry.el.style.display = entry.display;
            entry.el.style.pointerEvents = entry.pointerEvents;
            if (entry.ariaHidden == null) entry.el.removeAttribute('aria-hidden');
            else entry.el.setAttribute('aria-hidden', entry.ariaHidden);
        }
    };
}
