// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Public API pin for the AgentHooks assembly.
//
// Binary-compatibility rule for the published package: add overloads,
// never change a published signature. An optional parameter added to
// an existing method is source compatible, but a caller compiled
// against the old shape binds to the old parameter list and fails
// with MissingMethodException at run time (0.1.0-beta.2 did this to
// InterceptionEmitter.Register, and to the InterceptionRecord primary
// constructor). The fix is to keep the old method as a forwarding
// overload. The same rule covers constructors, Deconstruct, property
// types and return types.
//
// This test renders every public type and member of the assembly and
// compares the text with PublicApi.approved.txt. A line that
// disappears is a removed or changed signature, which is a break for
// every assembly compiled against the earlier release; a new line is
// new surface. To accept a deliberate change, run the tests with
// AGENT_HOOKS_APPROVE_PUBLIC_API=1 (rewrites the approved file in the
// source tree) or copy PublicApi.received.txt from the test output
// directory over the approved file, then say so in CHANGELOG.md.

using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using AgentHooks;
using Xunit;

namespace AgentHooks.Tests;

public sealed class PublicApiTests
{
    private const string ApprovedFile = "PublicApi.approved.txt";
    private const string ReceivedFile = "PublicApi.received.txt";

    [Fact]
    public void PublicSurfaceMatchesApprovedFile()
    {
        var actual = PublicApiRenderer.Render(typeof(InterceptionEmitter).Assembly);
        var sourcePath = Path.Combine(SourceDirectory(), ApprovedFile);
        if (Environment.GetEnvironmentVariable("AGENT_HOOKS_APPROVE_PUBLIC_API") == "1")
            File.WriteAllText(sourcePath, actual);

        // The source copy is authoritative; the build copies it to the
        // output directory for runs away from the source tree.
        var approvedPath = File.Exists(sourcePath)
            ? sourcePath
            : Path.Combine(AppContext.BaseDirectory, ApprovedFile);
        var expected = File.Exists(approvedPath) ? File.ReadAllText(approvedPath) : "";

        var expectedLines = Lines(expected);
        var actualLines = Lines(actual);
        if (expectedLines.SequenceEqual(actualLines, StringComparer.Ordinal)) return;

        var receivedPath = Path.Combine(AppContext.BaseDirectory, ReceivedFile);
        File.WriteAllText(receivedPath, actual);
        var removed = expectedLines.Except(actualLines, StringComparer.Ordinal).ToList();
        var added = actualLines.Except(expectedLines, StringComparer.Ordinal).ToList();
        var report = new StringBuilder()
            .AppendLine("The public API of the AgentHooks assembly differs from " + ApprovedFile + ".")
            .AppendLine("Removed or changed signatures break every assembly compiled against the")
            .AppendLine("published package: keep the old signature as a forwarding overload.")
            .AppendLine("Deliberate change: set AGENT_HOOKS_APPROVE_PUBLIC_API=1 for one test run, or copy")
            .AppendLine(receivedPath)
            .AppendLine("over sdk/dotnet/test/AgentHooks.Tests/" + ApprovedFile + ", and note it in CHANGELOG.md.");
        if (removed.Count > 0)
            report.AppendLine().AppendLine("Missing from the assembly (removed or changed):")
                .AppendJoin('\n', removed.Select(l => "  - " + l.Trim())).AppendLine();
        if (added.Count > 0)
            report.AppendLine().AppendLine("New in the assembly (not yet approved):")
                .AppendJoin('\n', added.Select(l => "  + " + l.Trim())).AppendLine();
        if (removed.Count == 0 && added.Count == 0)
            report.AppendLine().AppendLine("Same lines, different order or duplicates.");
        Assert.Fail(report.ToString());
    }

    private static string[] Lines(string text) =>
        text.Replace("\r\n", "\n").Split('\n')
            .Where(l => l.Length > 0)
            .ToArray();

    private static string SourceDirectory([CallerFilePath] string path = "") =>
        Path.GetDirectoryName(path)!;
}

/// <summary>Renders the public surface of an assembly as one sorted
/// line per type or member, in a C#-like notation: modifiers, type,
/// name, parameters with defaults, nullable annotations. Only the
/// public surface is listed, so protected members, compiler-generated
/// names and non-exported types do not appear.</summary>
internal static class PublicApiRenderer
{
    private static readonly Dictionary<Type, string> Keywords = new()
    {
        [typeof(void)] = "void",
        [typeof(object)] = "object",
        [typeof(string)] = "string",
        [typeof(bool)] = "bool",
        [typeof(byte)] = "byte",
        [typeof(sbyte)] = "sbyte",
        [typeof(short)] = "short",
        [typeof(ushort)] = "ushort",
        [typeof(int)] = "int",
        [typeof(uint)] = "uint",
        [typeof(long)] = "long",
        [typeof(ulong)] = "ulong",
        [typeof(char)] = "char",
        [typeof(float)] = "float",
        [typeof(double)] = "double",
        [typeof(decimal)] = "decimal",
    };

    private const BindingFlags Declared =
        BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    public static string Render(Assembly assembly)
    {
        var nullability = new NullabilityInfoContext();
        var sb = new StringBuilder();
        foreach (var type in assembly.GetExportedTypes()
                     .OrderBy(t => TypeName(t, null), StringComparer.Ordinal))
        {
            sb.Append(TypeHeader(type, nullability)).Append('\n');
            // Enum members keep value order; everything else sorts by line.
            var members = Members(type, nullability).Distinct(StringComparer.Ordinal);
            if (!type.IsEnum) members = members.OrderBy(l => l, StringComparer.Ordinal);
            foreach (var line in members)
                sb.Append("    ").Append(line).Append('\n');
        }
        return sb.ToString();
    }

    private static string TypeHeader(Type t, NullabilityInfoContext ctx)
    {
        var name = TypeName(t, null);
        if (t.IsEnum)
            return $"enum {name} : {TypeName(Enum.GetUnderlyingType(t), null)}";
        if (typeof(Delegate).IsAssignableFrom(t))
        {
            var invoke = t.GetMethod("Invoke")!;
            return $"delegate {Return(invoke, ctx)} {name}({Parameters(invoke, ctx)})";
        }

        var kind = t.IsInterface ? "interface"
            : t.IsValueType ? (IsRecord(t) ? "record struct" : "struct")
            : t.IsAbstract && t.IsSealed ? "static class"
            : (t.IsAbstract ? "abstract " : t.IsSealed ? "sealed " : "") + (IsRecord(t) ? "record class" : "class");
        var bases = new List<string>();
        if (t.BaseType is { } b && b != typeof(object) && b != typeof(ValueType))
            bases.Add(TypeName(b, null));
        var inherited = t.BaseType?.GetInterfaces() ?? [];
        bases.AddRange(t.GetInterfaces().Except(inherited)
            .Select(i => TypeName(i, null)).OrderBy(n => n, StringComparer.Ordinal));
        return $"{kind} {name}" + (bases.Count > 0 ? " : " + string.Join(", ", bases) : "");
    }

    private static IEnumerable<string> Members(Type t, NullabilityInfoContext ctx)
    {
        if (t.IsEnum)
        {
            var underlying = Enum.GetUnderlyingType(t);
            foreach (var name in Enum.GetNames(t))
                yield return $"{name} = {Convert.ChangeType(Enum.Parse(t, name), underlying)}";
            yield break;
        }
        if (typeof(Delegate).IsAssignableFrom(t)) yield break;

        foreach (var f in t.GetFields(Declared))
        {
            var type = TypeName(f.FieldType, Nullability(() => ctx.Create(f)));
            if (f.IsLiteral)
                yield return $"const {type} {f.Name} = {Literal(f.GetRawConstantValue(), f.FieldType)}";
            else
                yield return $"{(f.IsStatic ? "static " : "")}{(f.IsInitOnly ? "readonly " : "")}{type} {f.Name}";
        }
        foreach (var c in t.GetConstructors(Declared))
            yield return $"{ShortName(t)}({Parameters(c, ctx)})";
        foreach (var p in t.GetProperties(Declared))
        {
            var accessor = p.GetMethod ?? p.SetMethod!;
            var modifiers = (accessor.IsStatic ? "static " : "")
                + (p.GetCustomAttribute<RequiredMemberAttribute>() is not null ? "required " : "");
            var type = TypeName(p.PropertyType, Nullability(() => ctx.Create(p)));
            var indexers = p.GetIndexParameters();
            var name = indexers.Length > 0
                ? $"this[{string.Join(", ", indexers.Select(i => Parameter(i, ctx)))}]"
                : p.Name;
            var accessors = (p.GetMethod?.IsPublic == true ? "get; " : "")
                + (p.SetMethod?.IsPublic == true ? (IsInit(p.SetMethod) ? "init; " : "set; ") : "");
            yield return $"{modifiers}{type} {name} {{ {accessors}}}";
        }
        foreach (var e in t.GetEvents(Declared))
            yield return $"{(e.AddMethod!.IsStatic ? "static " : "")}event {TypeName(e.EventHandlerType!, null)} {e.Name}";
        foreach (var m in t.GetMethods(Declared))
        {
            if (m.Name.Contains('<')) continue; // compiler-generated, e.g. the record clone method
            if (m.IsSpecialName && !m.Name.StartsWith("op_", StringComparison.Ordinal)) continue; // accessors
            var modifiers = m.IsStatic ? "static "
                : t.IsInterface ? ""
                : m.IsAbstract ? "abstract "
                : m.GetBaseDefinition() != m ? (m.IsFinal ? "sealed override " : "override ")
                : m.IsVirtual && !m.IsFinal ? "virtual "
                : "";
            var generics = m.IsGenericMethodDefinition
                ? "<" + string.Join(", ", m.GetGenericArguments().Select(a => a.Name)) + ">"
                : "";
            if (m.Name is "op_Implicit" or "op_Explicit")
            {
                var kind = m.Name == "op_Implicit" ? "implicit" : "explicit";
                yield return $"static {kind} operator {Return(m, ctx)}({Parameters(m, ctx)})";
                continue;
            }
            var name = m.Name.StartsWith("op_", StringComparison.Ordinal) ? Operator(m.Name) : m.Name;
            yield return $"{modifiers}{Return(m, ctx)} {name}{generics}({Parameters(m, ctx)})";
        }
    }

    private static string Operator(string name) => name switch
    {
        "op_Equality" => "operator ==",
        "op_Inequality" => "operator !=",
        _ => name,
    };

    private static bool IsRecord(Type t) =>
        t.GetMethod("<Clone>$", BindingFlags.Public | BindingFlags.Instance) is not null;

    private static bool IsInit(MethodInfo setter) =>
        setter.ReturnParameter.GetRequiredCustomModifiers().Contains(typeof(IsExternalInit));

    private static string Return(MethodInfo m, NullabilityInfoContext? ctx = null) =>
        TypeName(m.ReturnType, ctx is null ? null : Nullability(() => ctx.Create(m.ReturnParameter)));

    private static string Parameters(MethodBase m, NullabilityInfoContext? ctx = null)
    {
        var isExtension = m.GetCustomAttribute<ExtensionAttribute>() is not null;
        return string.Join(", ", m.GetParameters().Select((p, i) =>
            (isExtension && i == 0 ? "this " : "") + Parameter(p, ctx)));
    }

    private static string Parameter(ParameterInfo p, NullabilityInfoContext? ctx)
    {
        var modifier = p.GetCustomAttribute<ParamArrayAttribute>() is not null ? "params "
            : !p.ParameterType.IsByRef ? ""
            : p.IsOut ? "out "
            : p.IsIn ? "in "
            : "ref ";
        var type = TypeName(p.ParameterType, ctx is null ? null : Nullability(() => ctx.Create(p)));
        var suffix = p.HasDefaultValue ? " = " + Literal(p.DefaultValue, p.ParameterType) : "";
        return $"{modifier}{type} {p.Name}{suffix}";
    }

    private static NullabilityInfo? Nullability(Func<NullabilityInfo> create)
    {
        try { return create(); }
        catch (ArgumentException) { return null; }
    }

    private static string Literal(object? value, Type type)
    {
        if (type.IsByRef) type = type.GetElementType()!;
        if (value is null) return type.IsValueType && Nullable.GetUnderlyingType(type) is null ? "default" : "null";
        if (type.IsEnum) return $"{TypeName(type, null)}.{Enum.GetName(type, value) ?? value.ToString()}";
        return value switch
        {
            string s => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"",
            bool b => b ? "true" : "false",
            IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
            _ => value.ToString() ?? "null",
        };
    }

    private static string ShortName(Type t)
    {
        var name = t.Name;
        var tick = name.IndexOf('`');
        return tick < 0 ? name : name[..tick];
    }

    private static string TypeName(Type t, NullabilityInfo? n)
    {
        if (t.IsByRef) return TypeName(t.GetElementType()!, n);
        if (t.IsGenericParameter) return t.Name;
        if (t.IsArray) return TypeName(t.GetElementType()!, n?.ElementType) + "[]" + NullableSuffix(n);
        if (Nullable.GetUnderlyingType(t) is { } underlying) return TypeName(underlying, null) + "?";
        if (Keywords.TryGetValue(t, out var keyword)) return keyword + NullableSuffix(n);

        var name = t.IsNested ? TypeName(t.DeclaringType!, null) + "." + ShortName(t) : ShortName(t);
        if (t.IsGenericType)
        {
            var args = t.GetGenericArguments();
            var infos = n is not null && n.GenericTypeArguments.Length == args.Length ? n.GenericTypeArguments : null;
            name += "<" + string.Join(", ", args.Select((a, i) => TypeName(a, infos?[i]))) + ">";
        }
        return name + NullableSuffix(n);
    }

    private static string NullableSuffix(NullabilityInfo? n) =>
        n is not null && !n.Type.IsValueType
        && (n.ReadState == NullabilityState.Nullable || n.WriteState == NullabilityState.Nullable)
            ? "?"
            : "";
}
