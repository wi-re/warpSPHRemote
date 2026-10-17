# Third-party components

Runtime dependencies are declared in package.json / package-lock.json and
pyproject.toml. Their upstream license notices remain in the installed packages.
Consult those packages for their full license terms.

The bundled color lookup tables are sampled from Matplotlib with
`examples/generate_colormaps.py`. The Matplotlib license accompanying that source
is retained in `third_party/MATPLOTLIB_LICENSE`; see also
https://matplotlib.org/stable/project/license.html . The tables retain the names
of their source palettes. No upstream endorsement is implied.
