# Third-party components

Runtime dependencies are declared in package.json / package-lock.json and
pyproject.toml. Their upstream license notices remain in the installed packages.
Consult those packages for their full license terms.

The bundled color lookup tables are sampled from Matplotlib with
`examples/generate_colormaps.py`. The Matplotlib license accompanying that source
is retained in `third_party/MATPLOTLIB_LICENSE`; see also
https://matplotlib.org/stable/project/license.html . The tables retain the names
of their source palettes. No upstream endorsement is implied.

Browser HDF5 decoding uses **h5wasm**, developed by the National Institute of
Standards and Technology, including HDF5 and Emscripten components. Its complete
notice is preserved in `web/public/licenses/h5wasm.txt` and shipped with every
static build. NPZ decompression uses **fflate**; its MIT notice is preserved in
`web/public/licenses/fflate.txt`. Neither upstream library was modified.
