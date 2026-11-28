# __NAME__: one line on what it is in the game, and the box its board gives it (size=1x1x1 on ModelProp).
# A starting point, not a model: replace the block below with the model the brief asks for, and
# make model.css's sample palette the brief's colours first. Crate.py and Tree.py in ds/__DS__/models/
# are worked examples.
#
# Helpers deploy design check hands this script (sizes and places in metres, angles in degrees, XYZ):
#   part(kind, name, size, at, colour, rotate=(0, 0, 0), bevel=0, sides=12)
#     a box, cylinder, cone or sphere; size is its box (x wide, y deep, z tall), at its centre.
#   lathe(name, profile, at=(0, 0, 0), colour=None, sides=16, rotate=(0, 0, 0))
#     turned round z from [(radius, z), ...] bottom to top: a pot, a bottle, a post, a dome.
#     A radius of 0 closes that end.
#   beam(name, start, end, width, colour=None, depth=None, sides=0)
#     a box (or, with sides, a cylinder) from one point to another: a strut, a rope, a branch, a rail.
#   pal(name) is the material for a palette colour in model.css (--pal-stone is pal('stone')).
# Blender is z-up and the model stands on the ground at the origin: x and y centred, z from 0.
# The check lists by name any part that leaves the box, so name each part for what it is.

part('box', 'block', (0.6, 0.6, 0.6), at=(0, 0, 0.3), colour='stone')
