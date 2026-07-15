// Adapted from serde_jcs 0.2.0 (https://github.com/l1h3r/serde_jcs),
// dual-licensed MIT OR Apache-2.0 and vendored here under the MIT
// license; see THIRD-PARTY-NOTICES.md at the repository root.
//
//! JSON Canonicalization Scheme (JCS)
//!
//! ### References
//!
//! [RFC 8785](https://tools.ietf.org/html/rfc8785)
//!

use ryu_js::Buffer;
use serde::ser::Serializer;
use serde::Serialize;
use serde_json::from_slice;
use serde_json::from_str;
use serde_json::ser::CharEscape;
use serde_json::ser::Formatter;
use serde_json::Error;
use serde_json::Serializer as JsonSerializer;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::io::Write;
use std::mem::take;

/// Serialize the given value as a String of JSON.
///
/// Serialization is performed as specified in [RFC 8785](https://tools.ietf.org/html/rfc8785).
///
/// # Errors
///
/// Serialization can fail if `T`'s implementation of `Serialize` fails.
#[inline]
pub fn to_string<T>(value: &T) -> Result<String, Error>
where
    T: Serialize + ?Sized,
{
    let data: Vec<u8> = to_vec(value)?;

    // SAFETY: We only emit valid UTF-8.
    let data: String = unsafe { String::from_utf8_unchecked(data) };

    Ok(data)
}

/// Serialize the given value as a JSON byte vector.
///
/// Serialization is performed as specified in [RFC 8785](https://tools.ietf.org/html/rfc8785).
///
/// # Errors
///
/// Serialization can fail if `T`'s implementation of `Serialize` fails.
#[inline]
pub fn to_vec<T>(value: &T) -> Result<Vec<u8>, Error>
where
    T: Serialize + ?Sized,
{
    let mut data: Vec<u8> = Vec::with_capacity(128);

    to_writer(&mut data, value)?;

    Ok(data)
}

/// Serialize the given value as JSON into the IO stream.
///
/// Serialization is performed as specified in [RFC 8785](https://tools.ietf.org/html/rfc8785).
///
/// # Errors
///
/// Serialization can fail if `T`'s implementation of `Serialize` fails.
#[inline]
pub fn to_writer<W, T>(writer: W, value: &T) -> Result<(), Error>
where
    W: Write,
    T: Serialize + ?Sized,
{
    value.serialize(&mut JcsSerializer::new(writer))
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

#[inline]
fn invalid_float() -> io::Error {
    io::Error::other("invalid float value")
}

#[inline]
fn invalid_key() -> io::Error {
    io::Error::other("invalid UTF-8 key")
}

// -----------------------------------------------------------------------------
// UTF-16 Key
// -----------------------------------------------------------------------------

struct Utf16Key {
    tag: Vec<u16>,
    key: Vec<u8>,
}

impl Utf16Key {
    fn new(key: Vec<u8>) -> io::Result<Self> {
        let tag: Vec<u16> = from_slice::<Value>(&key)?
            .as_str()
            .ok_or_else(invalid_key)?
            .encode_utf16()
            .collect();

        Ok(Self { tag, key })
    }
}

impl PartialEq for Utf16Key {
    #[inline]
    fn eq(&self, other: &Self) -> bool {
        self.tag.eq(&other.tag)
    }
}

impl Eq for Utf16Key {}

impl PartialOrd for Utf16Key {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Utf16Key {
    #[inline]
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.tag.cmp(&other.tag)
    }
}

// -----------------------------------------------------------------------------
// Formatter Entry
// -----------------------------------------------------------------------------

struct Entry {
    object: BTreeMap<Utf16Key, Vec<u8>>,
    next_key: Vec<u8>,
    next_val: Vec<u8>,
    complete: bool,
}

impl Entry {
    #[inline]
    const fn new() -> Self {
        Self {
            object: BTreeMap::new(),
            next_key: Vec::new(),
            next_val: Vec::new(),
            complete: false,
        }
    }

    #[inline]
    const fn complete(&mut self, value: bool) {
        self.complete = value;
    }
}

// -----------------------------------------------------------------------------
// JSON Formatter
// -----------------------------------------------------------------------------

struct JcsFormatter {
    entries: Vec<Entry>,
}

impl JcsFormatter {
    #[inline]
    const fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    #[inline]
    fn scope<'a, W>(&'a mut self, writer: &'a mut W) -> Box<dyn Write + 'a>
    where
        W: Write + ?Sized,
    {
        match self.entry_mut() {
            Some(entry) if entry.complete => Box::new(&mut entry.next_val),
            Some(entry) => Box::new(&mut entry.next_key),
            None => Box::new(writer),
        }
    }

    #[inline]
    fn entry_mut(&mut self) -> Option<&mut Entry> {
        self.entries.last_mut()
    }
}

impl Formatter for JcsFormatter {
    #[inline]
    fn write_null<W>(&mut self, writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.scope(writer).write_all(b"null")
    }

    #[inline]
    fn write_bool<W>(&mut self, writer: &mut W, value: bool) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        if value {
            self.scope(writer).write_all(b"true")
        } else {
            self.scope(writer).write_all(b"false")
        }
    }

    #[inline]
    fn write_char_escape<W>(&mut self, writer: &mut W, escape: CharEscape) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        #[inline]
        fn serialize(control: u8) -> [u8; 6] {
            static HEX: [u8; 16] = *b"0123456789abcdef";
            [
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[(control >> 4) as usize],
                HEX[(control & 0xF) as usize],
            ]
        }

        match escape {
            CharEscape::Quote => self.scope(writer).write_all(b"\\\""),
            CharEscape::ReverseSolidus => self.scope(writer).write_all(b"\\\\"),
            CharEscape::Solidus => self.scope(writer).write_all(b"/"),
            CharEscape::Backspace => self.scope(writer).write_all(b"\\b"),
            CharEscape::FormFeed => self.scope(writer).write_all(b"\\f"),
            CharEscape::LineFeed => self.scope(writer).write_all(b"\\n"),
            CharEscape::CarriageReturn => self.scope(writer).write_all(b"\\r"),
            CharEscape::Tab => self.scope(writer).write_all(b"\\t"),
            CharEscape::AsciiControl(control) => self.scope(writer).write_all(&serialize(control)),
        }
    }

    #[inline]
    fn write_number_str<W>(&mut self, writer: &mut W, value: &str) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, value.parse().map_err(io::Error::other)?)
    }

    #[inline]
    fn write_string_fragment<W>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.scope(writer).write_all(fragment.as_bytes())
    }

    #[inline]
    fn write_raw_fragment<W>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        let scope: Box<dyn Write> = self.scope(writer);
        let value: Value = from_str(fragment)?;

        to_writer(scope, &value).map_err(Into::into)
    }

    #[inline]
    fn write_i8<W>(&mut self, writer: &mut W, value: i8) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[inline]
    fn write_i16<W>(&mut self, writer: &mut W, value: i16) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[inline]
    fn write_i32<W>(&mut self, writer: &mut W, value: i32) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[expect(clippy::cast_precision_loss)]
    #[inline]
    fn write_i64<W>(&mut self, writer: &mut W, value: i64) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, value as f64)
    }

    #[expect(clippy::cast_precision_loss)]
    #[inline]
    fn write_i128<W>(&mut self, writer: &mut W, value: i128) -> io::Result<()>
    where
        W: ?Sized + Write,
    {
        self.write_f64(writer, value as f64)
    }

    #[inline]
    fn write_u8<W>(&mut self, writer: &mut W, value: u8) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[inline]
    fn write_u16<W>(&mut self, writer: &mut W, value: u16) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[inline]
    fn write_u32<W>(&mut self, writer: &mut W, value: u32) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[expect(clippy::cast_precision_loss)]
    #[inline]
    fn write_u64<W>(&mut self, writer: &mut W, value: u64) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, value as f64)
    }

    #[expect(clippy::cast_precision_loss)]
    #[inline]
    fn write_u128<W>(&mut self, writer: &mut W, value: u128) -> io::Result<()>
    where
        W: ?Sized + Write,
    {
        self.write_f64(writer, value as f64)
    }

    #[inline]
    fn write_f32<W>(&mut self, writer: &mut W, value: f32) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.write_f64(writer, f64::from(value))
    }

    #[inline]
    fn write_f64<W>(&mut self, writer: &mut W, value: f64) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        if value.is_finite() {
            let mut buffer: Buffer = Buffer::new();
            let mut writer: Box<dyn Write> = self.scope(writer);

            writer.write_all(buffer.format_finite(value).as_bytes())
        } else {
            Err(invalid_float())
        }
    }

    #[inline]
    fn begin_string<W>(&mut self, writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.scope(writer).write_all(b"\"")
    }

    #[inline]
    fn end_string<W>(&mut self, writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.scope(writer).write_all(b"\"")
    }

    #[inline]
    fn begin_array<W>(&mut self, writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.scope(writer).write_all(b"[")
    }

    #[inline]
    fn end_array<W>(&mut self, writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.scope(writer).write_all(b"]")
    }

    #[inline]
    fn begin_array_value<W>(&mut self, writer: &mut W, first: bool) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        if first {
            Ok(())
        } else {
            self.scope(writer).write_all(b",")
        }
    }

    #[inline]
    fn end_array_value<W>(&mut self, _writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        Ok(())
    }

    #[inline]
    fn begin_object<W>(&mut self, _writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.entries.push(Entry::new());

        Ok(())
    }

    fn end_object<W>(&mut self, writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        let entry: Entry = self
            .entries
            .pop()
            .ok_or_else(|| io::Error::other("end_object called before begin_object"))?;

        let mut scope: Box<dyn Write> = self.scope(writer);

        scope.write_all(b"{")?;

        for (index, (key, val)) in entry.object.into_iter().enumerate() {
            if index != 0 {
                scope.write_all(b",")?;
            }

            scope.write_all(&key.key)?;
            scope.write_all(b":")?;
            scope.write_all(&val)?;
        }

        scope.write_all(b"}")?;

        Ok(())
    }

    #[inline]
    fn begin_object_key<W>(&mut self, _writer: &mut W, _first: bool) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.entry_mut()
            .ok_or_else(|| io::Error::other("begin_object_key called before begin_object"))
            .map(|entry| entry.complete(false))
    }

    #[inline]
    fn end_object_key<W>(&mut self, _writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        self.entry_mut()
            .ok_or_else(|| io::Error::other("end_object_key called before begin_object"))
            .map(|entry| entry.complete(true))
    }

    #[inline]
    fn begin_object_value<W>(&mut self, _writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        Ok(())
    }

    fn end_object_value<W>(&mut self, _writer: &mut W) -> io::Result<()>
    where
        W: Write + ?Sized,
    {
        let entry: &mut Entry = self
            .entry_mut()
            .ok_or_else(|| io::Error::other("end_object_value called before begin_object"))?;

        let key: Vec<u8> = take(&mut entry.next_key);
        let val: Vec<u8> = take(&mut entry.next_val);

        entry.object.insert(Utf16Key::new(key)?, val);

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// JSON Serializer
// -----------------------------------------------------------------------------

type Proxy<'a, W> = &'a mut JsonSerializer<W, JcsFormatter>;

struct JcsSerializer<W> {
    inner: JsonSerializer<W, JcsFormatter>,
}

impl<W> JcsSerializer<W> {
    #[inline]
    fn new(writer: W) -> Self
    where
        W: Write,
    {
        Self {
            inner: JsonSerializer::with_formatter(writer, JcsFormatter::new()),
        }
    }
}

impl<'a, W> Serializer for &'a mut JcsSerializer<W>
where
    W: Write,
{
    type Ok = <Proxy<'a, W> as Serializer>::Ok;
    type Error = <Proxy<'a, W> as Serializer>::Error;

    type SerializeSeq = <Proxy<'a, W> as Serializer>::SerializeSeq;
    type SerializeTuple = <Proxy<'a, W> as Serializer>::SerializeTuple;
    type SerializeTupleStruct = <Proxy<'a, W> as Serializer>::SerializeTupleStruct;
    type SerializeTupleVariant = <Proxy<'a, W> as Serializer>::SerializeTupleVariant;
    type SerializeMap = <Proxy<'a, W> as Serializer>::SerializeMap;
    type SerializeStruct = <Proxy<'a, W> as Serializer>::SerializeStruct;
    type SerializeStructVariant = <Proxy<'a, W> as Serializer>::SerializeStructVariant;

    #[inline]
    fn serialize_bool(self, value: bool) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_bool(value)
    }

    #[inline]
    fn serialize_i8(self, value: i8) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i8(value)
    }

    #[inline]
    fn serialize_i16(self, value: i16) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i16(value)
    }

    #[inline]
    fn serialize_i32(self, value: i32) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i32(value)
    }

    #[inline]
    fn serialize_i64(self, value: i64) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i64(value)
    }

    #[inline]
    fn serialize_u8(self, value: u8) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u8(value)
    }

    #[inline]
    fn serialize_u16(self, value: u16) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u16(value)
    }

    #[inline]
    fn serialize_u32(self, value: u32) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u32(value)
    }

    #[inline]
    fn serialize_u64(self, value: u64) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u64(value)
    }

    #[inline]
    fn serialize_f32(self, value: f32) -> Result<Self::Ok, Self::Error> {
        if value.is_finite() {
            self.inner.serialize_f32(value)
        } else {
            Err(Self::Error::io(invalid_float()))
        }
    }

    #[inline]
    fn serialize_f64(self, value: f64) -> Result<Self::Ok, Self::Error> {
        if value.is_finite() {
            self.inner.serialize_f64(value)
        } else {
            Err(Self::Error::io(invalid_float()))
        }
    }

    #[inline]
    fn serialize_char(self, value: char) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_char(value)
    }

    #[inline]
    fn serialize_str(self, value: &str) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_str(value)
    }

    #[inline]
    fn serialize_bytes(self, value: &[u8]) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_bytes(value)
    }

    #[inline]
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_none()
    }

    #[inline]
    fn serialize_some<T>(self, value: &T) -> Result<Self::Ok, Self::Error>
    where
        T: ?Sized + Serialize,
    {
        self.inner.serialize_some(value)
    }

    #[inline]
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_unit()
    }

    #[inline]
    fn serialize_unit_struct(self, name: &'static str) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_unit_struct(name)
    }

    #[inline]
    fn serialize_unit_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, Self::Error> {
        self.inner
            .serialize_unit_variant(name, variant_index, variant)
    }

    #[inline]
    fn serialize_newtype_struct<T>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error>
    where
        T: ?Sized + Serialize,
    {
        self.inner.serialize_newtype_struct(name, value)
    }

    #[inline]
    fn serialize_newtype_variant<T>(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error>
    where
        T: ?Sized + Serialize,
    {
        self.inner
            .serialize_newtype_variant(name, variant_index, variant, value)
    }

    #[inline]
    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
        self.inner.serialize_seq(len)
    }

    #[inline]
    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> {
        self.inner.serialize_tuple(len)
    }

    #[inline]
    fn serialize_tuple_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct, Self::Error> {
        self.inner.serialize_tuple_struct(name, len)
    }

    #[inline]
    fn serialize_tuple_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleVariant, Self::Error> {
        self.inner
            .serialize_tuple_variant(name, variant_index, variant, len)
    }

    #[inline]
    fn serialize_map(self, len: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
        self.inner.serialize_map(len)
    }

    #[inline]
    fn serialize_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStruct, Self::Error> {
        self.inner.serialize_struct(name, len)
    }

    #[inline]
    fn serialize_struct_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStructVariant, Self::Error> {
        self.inner
            .serialize_struct_variant(name, variant_index, variant, len)
    }
}
