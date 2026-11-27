# Crate: a wooden crate the hero can push, one metre on a side (size=1x1x1 on ModelCrate).
#
# A model is built here with bpy, and two helpers deploy design check hands it:
#   part(kind, name, size, at, colour, rotate=(0, 0, 0), bevel=0, sides=12)
#     kind is box, cylinder, cone or sphere; size is its box in metres (x wide, y deep, z tall);
#     at is its centre; rotate is in degrees; bevel rounds its edges by that many metres.
#   pal(name) is the material for a palette colour in model.css (--pal-wood is pal('wood')).
# Blender is z-up and the model stands on the ground at the origin: x and y centred, z from 0.

# The body, a little inside the frame so the frame's edges catch the light.
part('box', 'body', (0.9, 0.9, 0.9), at=(0, 0, 0.5), colour='wood')

# Planks: a shallow groove across each side face, darker.
for z in (0.35, 0.65):
    part('box', f'groove front {z}', (0.84, 0.92, 0.03), at=(0, 0, z), colour='bark')
    part('box', f'groove side {z}', (0.92, 0.84, 0.03), at=(0, 0, z), colour='bark')

# The frame: a post on each corner and a rail round the top and the bottom.
for x in (-0.44, 0.44):
    for y in (-0.44, 0.44):
        part('box', f'post {x} {y}', (0.12, 0.12, 1.0), at=(x, y, 0.5), colour='bark', bevel=0.01)
# The rails run between the posts and sit a hair inside them, so no two faces meet flush.
for z in (0.06, 0.94):
    for y in (-0.44, 0.44):
        part('box', f'rail x {y} {z}', (0.78, 0.1, 0.1), at=(0, y, z), colour='bark')
    for x in (-0.44, 0.44):
        part('box', f'rail y {x} {z}', (0.1, 0.78, 0.1), at=(x, 0, z), colour='bark')

# A brace across the front, corner to corner.
part('box', 'brace', (1.0, 0.06, 0.1), at=(0, -0.46, 0.5), rotate=(0, -45, 0), colour='bark')
