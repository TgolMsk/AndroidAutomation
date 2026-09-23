// The CLI shares the packaged manager's runtime and core bundle. Electron can run
// this entry as Node when ELECTRON_RUN_AS_NODE=1, without a separate Node install.
import '../../../cli/src/index';
