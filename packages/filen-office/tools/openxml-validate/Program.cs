// Validates WordprocessingML, SpreadsheetML and PresentationML packages with the Open XML SDK
// (FileFormatVersions.Microsoft365): one file path per stdin line, one JSON line per file on stdout: {"file",
// "fatal"?, "errors": [{"id", "description", "path", "part"}]}, "fatal" when the SDK cannot open or walk the
// package. .pptx, .pptm, .potx, .potm, .ppsx and .ppsm open as presentations, .xlsx, .xlsm, .xltx and .xltm as
// spreadsheets, everything else as a word-processing document. MaxNumberOfErrors 0 lifts the limit of 1,000.
//
//   dotnet restore --locked-mode && dotnet build -c Release --no-restore
//   dotnet <ArtifactsPath>/bin/OpenXmlValidate/release/OpenXmlValidate.dll < files.txt
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365) { MaxNumberOfErrors = 0 };
string[] spreadsheetExtensions = [".xlsx", ".xlsm", ".xltx", ".xltm"];
string[] presentationExtensions = [".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm"];
using var stdout = Console.OpenStandardOutput();

string? file;

while ((file = Console.In.ReadLine()) is not null)
{
	if (file.Length == 0) continue;

	using var buffer = new MemoryStream();

	using (var json = new Utf8JsonWriter(buffer))
	{
		json.WriteStartObject();
		json.WriteString("file", file);

		// Path and part are read while the package is open: both resolve lazily.
		List<(string Id, string Description, string? Path, string? Part)> errors;
		string? fatal = null;

		try
		{
			var extension = Path.GetExtension(file).ToLowerInvariant();
			using OpenXmlPackage document = presentationExtensions.Contains(extension)
				? PresentationDocument.Open(file, false)
				: spreadsheetExtensions.Contains(extension)
					? SpreadsheetDocument.Open(file, false)
					: WordprocessingDocument.Open(file, false);

			errors = [.. validator.Validate(document).Select(error => (error.Id, error.Description, error.Path?.XPath, error.Part?.Uri.ToString()))];
		}
		catch (Exception exception)
		{
			errors = [];
			fatal = $"{exception.GetType().Name}: {exception.Message}";
		}

		if (fatal is not null) json.WriteString("fatal", fatal);

		json.WriteStartArray("errors");

		foreach (var error in errors)
		{
			json.WriteStartObject();
			json.WriteString("id", error.Id);
			json.WriteString("description", error.Description);
			json.WriteString("path", error.Path);
			json.WriteString("part", error.Part);
			json.WriteEndObject();
		}

		json.WriteEndArray();
		json.WriteEndObject();
	}

	buffer.WriteByte((byte)'\n');
	buffer.Position = 0;
	buffer.CopyTo(stdout);
	stdout.Flush();
}
