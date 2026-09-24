/**
 * Script DSL — pure logic only (types, validation, block tree, descriptions, interpolation).
 *
 * This entry is published as `@avdm/automation/script` for the renderer: it must never import sharp, OpenCV,
 * Node built-ins or anything else with side effects. The executing engine (which needs vision) is exported
 * from the package root instead. The script-engine port fills this module.
 */
export {};
