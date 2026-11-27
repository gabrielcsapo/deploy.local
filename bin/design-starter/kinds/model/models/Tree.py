# Tree: a pine for the forest edge, two and a half metres tall (size=1.4x1.4x2.5 on ModelTree).
# part() and pal() are described in Crate.py. Round parts take few sides: they read as round at
# play size and keep the triangle budget.

part('cylinder', 'trunk', (0.28, 0.28, 0.7), at=(0, 0, 0.35), colour='bark', sides=7)

# Three tiers of needles, each smaller and higher, turned a little so their edges do not line up.
for i, (width, height, z) in enumerate([(1.4, 1.0, 1.0), (1.1, 0.9, 1.5), (0.75, 0.8, 2.1)]):
    part(
        'cone',
        f'tier {i + 1}',
        (width, width, height),
        at=(0, 0, z),
        rotate=(0, 0, i * 17),
        colour='green' if i != 1 else 'leaf',
        sides=8,
    )
