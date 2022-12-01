import { Builders, Enums, Factories, Models } from '@cyclonedx/cyclonedx-library';
import { execSync, ExecSyncOptionsWithBufferEncoding } from "child_process";
import { PropertyNames, PropertyValueBool } from './properties';
import { PackageURL } from 'packageurl-js';

export type OmittableDependencyTypes = "dev" | "optional" | "peer";

export interface BomBuilderOptions {
  ignoreNpmErrors?: boolean;
  metaComponentType?: Enums.ComponentType;
  packageLockOnly?: boolean;
  omitDependencyTypes?: Set<OmittableDependencyTypes>;
  reproducible?: boolean;
  flattenComponents?: boolean;
  shortPURLs?: boolean;
}

class DummyComponent extends Models.Component {
  constructor(type: Models.Component["type"], name: Models.Component["name"]) {
    super(type, `DummyComponent.${name}`, {
      bomRef: `DummyComponent.${name}`,
      description: `This is a dummy component "${name}" that fills the gap where the actual built failed.`,
    });
  }
}

export function makeThisTool(
  builder: Builders.FromNodePackageJson.ToolBuilder
): Models.Tool | undefined {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const packageJson = require("../package.json");
  return builder.makeTool(packageJson);
}

function makeNpmRunner() {
  return (args: string[], options: ExecSyncOptionsWithBufferEncoding): Buffer =>
    execSync("npm " + args.join(" "), options);
}

type cPath = string;
type AllComponents = Map<cPath, Models.Component>;

export class BomBuilder {
  constructor(
    private toolBuilder: Builders.FromNodePackageJson.ToolBuilder,
    private componentBuilder: Builders.FromNodePackageJson.ComponentBuilder,
    private purlFactory: Factories.FromNodePackageJson.PackageUrlFactory,
    private options: BomBuilderOptions,
    private console: Console
  ) {}

  buildFromProjectDir(projectDir: string, process: NodeJS.Process) {
    return this.buildFromNpmLs(this.fetchNpmLs(projectDir, process));
  }

  private fetchNpmLs(projectDir: string, process_: NodeJS.Process): any {
    const npmRunner = makeNpmRunner();

    const args: string[] = [
      "ls",
      // format as parsable json
      "--json",
      // get all the needed content
      "--long",
      // depth = infinity
      "--depth",
    ];

    // TODO use instead ? : https://www.npmjs.com/package/debug ?
    this.console.info("INFO  | gather dependency tree ...");
    this.console.debug(
      "DEBUG | npm-ls: run npm with %j in %j",
      args,
      projectDir
    );
    let npmLsReturns: Buffer;
    try {
      npmLsReturns = npmRunner(args, {
        cwd: projectDir,
        env: process_.env,
        encoding: "buffer",
        maxBuffer: Number.MAX_SAFE_INTEGER, // DIRTY but effective
      });
    } catch (runError: any) {
      // this.console.group('DEBUG | npm-ls: STDOUT')
      // this.console.debug('%s', runError.stdout)
      // this.console.groupEnd()
      this.console.group("WARN  | npm-ls: MESSAGE");
      this.console.warn("%s", runError.message);
      this.console.groupEnd();
      this.console.group("ERROR | npm-ls: STDERR");
      this.console.error("%s", runError.stderr);
      this.console.groupEnd();
      if (!this.options.ignoreNpmErrors) {
        throw new Error(
          `npm-ls exited with errors: ${
            (runError.status as string) ?? "noStatus"
          } ${(runError.signal as string) ?? "noSignal"}`
        );
      }
      this.console.debug(
        "DEBUG | npm-ls exited with errors that are to be ignored."
      );
      npmLsReturns = runError.stdout ?? Buffer.alloc(0);
    }
    // this.console.debug('stdout: %s', npmLsReturns)
    try {
      return JSON.parse(npmLsReturns.toString());
    } catch (jsonParseError) {
      /* @ts-expect-error TS2554 */
      throw new Error("failed to parse pnpm-ls response", {
        cause: jsonParseError,
      });
    }
  }

  buildFromNpmLs(data: any): Models.Bom {
    // TODO use instead ? : https://www.npmjs.com/package/debug ?
    this.console.info("INFO  | build BOM ...");

    // region all components & dependencies

    /* eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing --
     * as we need to enforce a proper root component to enable all features of SBOM */
    const rootComponent: Models.Component =
      this.makeComponent(data, (this as any).metaComponentType) ||
      new DummyComponent((this as any).metaComponentType, "RootComponent");
    const allComponents: AllComponents = new Map([[data.path, rootComponent]]);
    // this.gatherDependencies(allComponents, data, rootComponent.dependencies);
    // this.finalizePathProperties(data.path, allComponents.values());

    // endregion all components & dependencies

    const bom = new Models.Bom();

    // region metadata

    // bom.metadata.component = rootComponent;

    const thisTool = makeThisTool(this.toolBuilder);
    if (thisTool !== undefined) {
      bom.metadata.tools.add(thisTool);
    }

    if (!this.options.reproducible) {
      bom.metadata.timestamp = new Date();
    }

    // endregion metadata

    // region components

    // bom.components = this.nestComponents(
    //     // remove rootComponent - so the elements that are nested below it are just returned.
    //     new Map(
    //         Array.from(allComponents.entries()).filter(
    //             ([, c]) => c !== rootComponent
    //         )
    //     ),
    //     this.treeBuilder.fromPaths(
    //         new Set(allComponents.keys()),
    //         // do not depend on `path.sep` -- this would be runtime-dependent, not input-dependent
    //         data.path[0] === '/' ? '/' : '\\'
    //     )
    // );
    bom.components.forEach((c) => (this as any).adjustNestedBomRefs(c, ""));
    // rootComponent.components.clear();

    if (this.options.flattenComponents) {
      for (const component of allComponents.values()) {
        component.components.clear();
        if (component !== rootComponent) {
          bom.components.add(component);
        }
      }
    }

    // endregion components

    return bom;
  }

  private makeComponent(
    data: any,
    type?: Enums.ComponentType | undefined
  ): Models.Component | false | undefined {
    const isDev = (data.dev ?? data._development) === true;
    if (isDev && this.options.omitDependencyTypes?.has("dev")) {
      this.console.debug(
        "DEBUG | omit dev component: %j %j",
        data.name,
        data._id
      );
      return false;
    }

    const component = this.componentBuilder.makeComponent(data, type);
    if (component === undefined) {
      this.console.debug(
        "DEBUG | skip broken component: %j %j",
        data.name,
        data._id
      );
      return undefined;
    }

    // region properties

    if (typeof data.path === "string") {
      component.properties.add(
        new Models.Property(PropertyNames.PackageInstallPath, data.path)
      );
    }
    if (isDev) {
      component.properties.add(
        new Models.Property(
          PropertyNames.PackageDevelopment,
          PropertyValueBool.True
        )
      );
    }
    if (data.extraneous === true) {
      component.properties.add(
        new Models.Property(
          PropertyNames.PackageExtraneous,
          PropertyValueBool.True
        )
      );
    }
    if (data.private === true) {
      component.properties.add(
        new Models.Property(
          PropertyNames.PackagePrivate,
          PropertyValueBool.True
        )
      );
    }
    // older npm-ls versions (v6) hide properties behind a `_`
    if ((data.inBundle ?? data._inBundle) === true) {
      component.properties.add(
        new Models.Property(
          PropertyNames.PackageBundled,
          PropertyValueBool.True
        )
      );
    }

    // endregion properties

    // older npm-ls versions (v6) hide properties behind a `_`
    const resolved = data.resolved ?? data._resolved;
    if (
      typeof resolved === "string" &&
      !this.resolvedRE_ignore.test(resolved)
    ) {
      component.externalReferences.add(
        new Models.ExternalReference(
          resolved,
          Enums.ExternalReferenceType.Distribution,
          { comment: 'as detected from npm-ls property "resolved"' }
        )
      );
    }

    // older npm-ls versions (v6) hide properties behind a `_`
    const integrity = data.integrity ?? data._integrity;
    if (typeof integrity === "string") {
      const hashSha512Match = this.hashRE_sha512_base64.exec(integrity) ?? [];
      if (hashSha512Match?.length === 2) {
        component.hashes.set(
          Enums.HashAlgorithm["SHA-512"],
          Buffer.from(hashSha512Match[1], "base64").toString("hex")
        );
      }
    }

    // even private packages may have a PURL for identification
    component.purl = this.makePurl(component);

    /* eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- since empty-string handling is needed */
    component.bomRef.value =
      (typeof data._id === "string" ? data._id : undefined) ||
      /* eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing -- since empty-string handling is needed */
      `${component.group || "-"}/${component.name}@${component.version || "-"}`;

    return component;
  }


  private makePurl (component: Models.Component): PackageURL | undefined {
    const purl = this.purlFactory.makeFromComponent(component, this.reproducible)
    if (purl === undefined) {
      return undefined
    }

    if (this.shortPURLs) {
      purl.qualifiers = undefined
      purl.subpath = undefined
    }

    return purl
  }
}
