# Screenshots of the meal planner, drawn as the app itself so they can be scaled into thumbnails.
B = {}
MEALS = [('Mon', 'Lemon chicken and rice'), ('Tue', 'Black bean tacos'), ('Wed', 'Leftovers'), ('Thu', 'Pasta with greens'), ('Fri', 'Homemade pizza')]
SERIF = 'font-family:Georgia,serif'

def phone_ui():
    rows = ''.join(f'<div style="display:flex;gap:12px;padding:12px 14px;margin-bottom:8px;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06);font-size:17px"><span style="width:40px;color:#b0602a;font-family:sans-serif;font-weight:600;font-size:15px">{d}</span>{m}</div>' for d, m in MEALS)
    return (f'<div style="width:390px;height:780px;box-sizing:border-box;background:#fffaf2;color:#2b2420;{SERIF};padding:56px 18px 0">'
            '<div style="font-size:26px;line-height:32px;font-weight:700">This week</div>'
            '<div style="font-family:sans-serif;font-size:13px;color:#8a7a6a;margin-bottom:12px">Oct 27 – Oct 31 · drag a recipe onto a day</div>'
            f'{rows}<div style="margin-top:12px;padding:12px 14px;border-radius:12px;background:#b0602a;color:#fff;font-family:sans-serif;font-size:16px;font-weight:600;text-align:center">Make the shopping list · 23 items</div></div>')

def phone_list_ui():
    items = ['Chicken thighs · 1.5 lb', 'Jasmine rice', 'Lemons · 3', 'Black beans · 2 cans', 'Corn tortillas', 'Pasta · 1 lb', 'Kale', 'Pizza dough · 2', 'Mozzarella']
    rows = ''.join(f'<div style="display:flex;align-items:center;gap:12px;padding:11px 4px;border-bottom:1px solid #eadfce;font-size:17px"><span style="width:20px;height:20px;border-radius:6px;border:1.5px solid #b0602a"></span>{t}</div>' for t in items)
    return (f'<div style="width:390px;height:780px;box-sizing:border-box;background:#fffaf2;color:#2b2420;{SERIF};padding:56px 18px 0">'
            '<div style="font-size:26px;line-height:32px;font-weight:700">Shopping list</div>'
            f'<div style="font-family:sans-serif;font-size:13px;color:#8a7a6a;margin-bottom:8px">23 items from this week · merged</div>{rows}</div>')

def laptop_ui():
    cols = ''.join(f'<div style="flex:1;display:flex;flex-direction:column;gap:8px"><span style="font-family:sans-serif;font-weight:600;color:#b0602a;font-size:15px">{d}</span><div style="padding:14px;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06);font-size:17px;min-height:120px">{m}</div></div>' for d, m in MEALS)
    return (f'<div style="width:1440px;height:900px;box-sizing:border-box;background:#fffaf2;color:#2b2420;{SERIF};padding:48px 56px;display:flex;gap:32px">'
            f'<div style="flex:1;display:flex;flex-direction:column;gap:20px"><div style="font-size:40px;font-weight:700">This week</div><div style="display:flex;gap:12px">{cols}</div></div>'
            '<div style="width:320px;padding:20px;border-radius:16px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06)"><div style="font-size:24px;font-weight:700;margin-bottom:12px">Shopping list</div>'
            + ''.join(f'<div style="padding:8px 0;border-bottom:1px solid #eadfce;font-size:16px">{t}</div>' for t in ('Chicken thighs', 'Jasmine rice', 'Lemons', 'Black beans', 'Tortillas', 'Pasta', 'Kale'))
            + '</div></div>')

def thumb(ui, w_src, h_src, w, label='', href='PreviewPhone.dc.html'):
    s = w / w_src
    cap = f'<span class="dl-meta" style="font-size:12px;line-height:16px">{label}</span>' if label else ''
    return (f'<a href="{href}" style="display:flex;flex-direction:column;gap:6px;flex:none"><span style="display:block;width:{w}px;height:{round(h_src * s)}px;overflow:hidden;border-radius:10px;box-shadow:0 0 0 1px var(--line-strong)">'
            f'<span style="display:block;transform:scale({s:.4f});transform-origin:0 0;width:{w_src}px;height:{h_src}px">{ui}</span></span>{cap}</a>')
