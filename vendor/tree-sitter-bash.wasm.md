# tree-sitter-bash.wasm

Vendored from `tree-sitter-bash@0.25.1`.

Source package: https://www.npmjs.com/package/tree-sitter-bash

To update, extract the wasm from the npm tarball:

```sh
npm pack tree-sitter-bash@0.25.1
tar xzf tree-sitter-bash-0.25.1.tgz
cp package/tree-sitter-bash.wasm vendor/tree-sitter-bash.wasm
rm -rf package tree-sitter-bash-0.25.1.tgz
```
