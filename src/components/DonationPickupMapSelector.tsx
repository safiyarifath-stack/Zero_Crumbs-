/// <reference types="google.maps" />
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Building2,
  CheckCircle2,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  RefreshCw,
  Search,
} from 'lucide-react';
import { auth } from '../firebase';
import type {
  NearbyCharityOrganisation,
  SelectedCharityOrganisation,
} from '../types';

export interface PickupLocationValue {
  address: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  confirmed: boolean;
}

interface DonationPickupMapSelectorProps {
  value: PickupLocationValue | null;
  selectedOrganisation: SelectedCharityOrganisation | null;
  onChangeLocation: (next: PickupLocationValue) => void;
  onSelectOrganisation: (org: SelectedCharityOrganisation | null) => void;
}

const DEFAULT_MAP_CENTER = { lat: 20.5937, lng: 78.9629 };
const DEFAULT_MAP_ZOOM = 5;

function formatDistance(meters?: number): string {
  if (typeof meters !== 'number' || Number.isNaN(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function emitQuotaExceededIfNeeded(status: number, body: { quotaExceeded?: boolean; error?: string }) {
  if (
    status === 429 ||
    body?.quotaExceeded ||
    (body?.error && body.error.toLowerCase().includes('quota'))
  ) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
}

function MapCameraController({
  target,
  zoom,
}: {
  target: { lat: number; lng: number } | null;
  zoom?: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || !target) return;
    map.panTo(target);
    if (typeof zoom === 'number') {
      const currentZoom = map.getZoom() ?? 0;
      if (currentZoom < zoom) {
        map.setZoom(zoom);
      }
    }
  }, [map, target, zoom]);

  return null;
}

function AddressAutocompleteInput({
  searchQuery,
  setSearchQuery,
  disabled,
  searching,
  onPickSuggestion,
  onSubmitSearch,
}: {
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  disabled: boolean;
  searching: boolean;
  onPickSuggestion: (coords: {
    lat: number;
    lng: number;
    address: string;
    placeId?: string;
  }) => void;
  onSubmitSearch: () => void;
}) {
  const placesLib = useMapsLibrary('places');
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    if (!placesLib || disabled) return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new AutocompleteSessionToken();
        }
        setLoadingSuggestions(true);
        const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: trimmed,
          sessionToken: sessionTokenRef.current,
        });
        if (!cancelled) {
          setSuggestions(res.suggestions || []);
          setDropdownOpen(true);
        }
      } catch {
        if (!cancelled) {
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingSuggestions(false);
        }
      }
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [placesLib, searchQuery, disabled]);

  const handleSelectSuggestion = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!placesLib || !suggestion.placePrediction) return;
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['id', 'formattedAddress', 'displayName', 'location'],
        });
        const loc = place.location;
        if (loc) {
          const lat = loc.lat();
          const lng = loc.lng();
          const address =
            place.formattedAddress ||
            suggestion.placePrediction.text?.text ||
            searchQuery;
          setSearchQuery(address);
          onPickSuggestion({
            lat,
            lng,
            address,
            placeId: place.id || undefined,
          });
        }
      } catch {
        onSubmitSearch();
      } finally {
        sessionTokenRef.current = null;
        setSuggestions([]);
        setDropdownOpen(false);
      }
    },
    [placesLib, onPickSuggestion, onSubmitSearch, searchQuery, setSearchQuery]
  );

  return (
    <div className="relative flex-1">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#6B7A70] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            disabled={disabled}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setDropdownOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setDropdownOpen(false);
                onSubmitSearch();
              }
            }}
            placeholder="Search street, neighborhood, landmark, or postal code"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] disabled:bg-[#F5F6F2] disabled:text-[#6B7A70]"
          />
        </div>
        <button
          type="button"
          disabled={disabled || searching || !searchQuery.trim()}
          onClick={() => {
            setDropdownOpen(false);
            onSubmitSearch();
          }}
          className="px-3.5 py-2.5 rounded-xl bg-[#EEF3EC] text-[#1B4332] text-xs font-medium hover:bg-[#DFEBDD] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
        >
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Find
        </button>
      </div>

      {dropdownOpen && !disabled && (suggestions.length > 0 || loadingSuggestions) && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-30 bg-white border border-[#DCE0D8] rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto">
          {loadingSuggestions && suggestions.length === 0 ? (
            <div className="px-3.5 py-2.5 text-xs text-[#5A6A60] flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching addresses...
            </div>
          ) : (
            suggestions.map((s, idx) => {
              const label = s.placePrediction?.text?.text || '';
              if (!label) return null;
              return (
                <button
                  key={`${s.placePrediction?.placeId || idx}`}
                  type="button"
                  onClick={() => void handleSelectSuggestion(s)}
                  className="w-full text-left px-3.5 py-2.5 text-xs text-[#1A2820] hover:bg-[#EEF3EC] border-b last:border-b-0 border-[#ECEEE8] flex items-start gap-2 cursor-pointer"
                >
                  <MapPin className="w-3.5 h-3.5 text-[#1B4332] mt-0.5 shrink-0" />
                  <span>{label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function DonationPickupMapSelector({
  value,
  selectedOrganisation,
  onChangeLocation,
  onSelectOrganisation,
}: DonationPickupMapSelectorProps) {
  const envApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  const [apiKey, setApiKey] = useState<string>(envApiKey);
  const [configLoaded, setConfigLoaded] = useState<boolean>(Boolean(envApiKey));

  const [searchQuery, setSearchQuery] = useState<string>(value?.address || '');
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number }>(
    value ? { lat: value.latitude, lng: value.longitude } : DEFAULT_MAP_CENTER
  );
  const [desiredZoom, setDesiredZoom] = useState<number>(value ? 15 : DEFAULT_MAP_ZOOM);

  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [mapError, setMapError] = useState('');

  const [charities, setCharities] = useState<NearbyCharityOrganisation[]>([]);
  const [searchingCharities, setSearchingCharities] = useState(false);
  const [charityError, setCharityError] = useState('');
  const [hasSearchedCharities, setHasSearchedCharities] = useState(false);
  const [activeInfoPlaceId, setActiveInfoPlaceId] = useState<string | null>(null);

  useEffect(() => {
    if (envApiKey) return;
    let active = true;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const resp = await fetch('/api/maps/config', { headers });
        if (!resp.ok) {
          if (active) setConfigLoaded(true);
          return;
        }
        const data = (await resp.json()) as { configured?: boolean; apiKey?: string };
        if (active) {
          if (data.configured && data.apiKey) {
            setApiKey(data.apiKey);
          }
          setConfigLoaded(true);
        }
      } catch {
        if (active) setConfigLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [envApiKey]);

  const fetchNearbyCharities = useCallback(
    async (lat: number, lng: number) => {
      setSearchingCharities(true);
      setCharityError('');
      setHasSearchedCharities(true);
      try {
        const headers = await getAuthHeaders();
        const resp = await fetch('/api/maps/nearby-charities', {
          method: 'POST',
          headers,
          body: JSON.stringify({ lat, lng, radiusMeters: 15000 }),
        });
        const data = (await resp.json()) as {
          organisations?: NearbyCharityOrganisation[];
          error?: string;
          quotaExceeded?: boolean;
        };
        if (!resp.ok) {
          emitQuotaExceededIfNeeded(resp.status, data);
          setCharityError(
            data.error || 'Could not load nearby charity organisations right now.'
          );
          setCharities([]);
          return;
        }
        setCharities(Array.isArray(data.organisations) ? data.organisations : []);
      } catch {
        setCharityError('Network error while searching nearby charity organisations.');
        setCharities([]);
      } finally {
        setSearchingCharities(false);
      }
    },
    []
  );

  // If editing an existing confirmed donation that already has coordinates, pre-load nearby charities once
  const initialFetchedRef = useRef(false);
  useEffect(() => {
    if (
      configLoaded &&
      apiKey &&
      value?.confirmed &&
      !initialFetchedRef.current
    ) {
      initialFetchedRef.current = true;
      void fetchNearbyCharities(value.latitude, value.longitude);
    }
  }, [configLoaded, apiKey, value, fetchNearbyCharities]);

  const reverseGeocodeCoords = useCallback(
    async (lat: number, lng: number) => {
      setGeocoding(true);
      setMapError('');
      setMapCenter({ lat, lng });
      setDesiredZoom(16);

      try {
        const headers = await getAuthHeaders();
        const resp = await fetch('/api/maps/reverse-geocode', {
          method: 'POST',
          headers,
          body: JSON.stringify({ lat, lng }),
        });
        const data = (await resp.json()) as {
          formattedAddress?: string;
          placeId?: string;
          noAddressFound?: boolean;
          error?: string;
          quotaExceeded?: boolean;
        };
        if (!resp.ok) {
          emitQuotaExceededIfNeeded(resp.status, data);
          setMapError(data.error || 'Could not resolve the street address for this pin.');
          onChangeLocation({
            address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            latitude: lat,
            longitude: lng,
            confirmed: false,
          });
          return;
        }
        const resolvedAddress =
          data.formattedAddress && data.formattedAddress.trim()
            ? data.formattedAddress.trim()
            : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        setSearchQuery(resolvedAddress);
        onChangeLocation({
          address: resolvedAddress,
          latitude: lat,
          longitude: lng,
          placeId: data.placeId || undefined,
          confirmed: false,
        });
        if (data.noAddressFound) {
          setMapError(
            'Pin placed, but no street address was returned for that exact spot. Adjust the pin slightly closer to a road.'
          );
        }
      } catch {
        setMapError('Could not fetch the street address. Please check your connection.');
      } finally {
        setGeocoding(false);
      }
    },
    [onChangeLocation]
  );

  const handleGeocodeSearch = useCallback(async () => {
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setMapError('Enter a street address, area, or postal code to search.');
      return;
    }
    setGeocoding(true);
    setMapError('');
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch('/api/maps/geocode', {
        method: 'POST',
        headers,
        body: JSON.stringify({ address: trimmed }),
      });
      const data = (await resp.json()) as {
        lat?: number;
        lng?: number;
        formattedAddress?: string;
        placeId?: string;
        error?: string;
        quotaExceeded?: boolean;
      };
      if (!resp.ok || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
        emitQuotaExceededIfNeeded(resp.status, data);
        setMapError(data.error || 'Address not found. Try a nearby landmark or drop the pin manually.');
        return;
      }
      const nextAddress = data.formattedAddress || trimmed;
      setSearchQuery(nextAddress);
      setMapCenter({ lat: data.lat, lng: data.lng });
      setDesiredZoom(16);
      onChangeLocation({
        address: nextAddress,
        latitude: data.lat,
        longitude: data.lng,
        placeId: data.placeId || undefined,
        confirmed: false,
      });
    } catch {
      setMapError('Could not search that address right now. Please try again.');
    } finally {
      setGeocoding(false);
    }
  }, [searchQuery, onChangeLocation]);

  const handleUseCurrentLocation = useCallback(() => {
    setMapError('');
    if (!('geolocation' in navigator)) {
      setMapError('Geolocation is not supported by your browser. Please search an address instead.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude, longitude } = pos.coords;
        void reverseGeocodeCoords(latitude, longitude);
      },
      (err) => {
        setLocating(false);
        if (err.code === err.PERMISSION_DENIED) {
          setMapError(
            'Location permission was denied. Allow location access in your browser or search your address manually.'
          );
        } else if (err.code === err.TIMEOUT) {
          setMapError('Timed out detecting your location. Please try again or search manually.');
        } else {
          setMapError('Could not detect your current location. Please drop a pin or search manually.');
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, [reverseGeocodeCoords]);

  const handleConfirmLocation = () => {
    if (!value) {
      setMapError('Please search an address, detect your location, or drop a pin on the map first.');
      return;
    }
    setMapError('');
    onChangeLocation({
      ...value,
      confirmed: true,
    });
    void fetchNearbyCharities(value.latitude, value.longitude);
  };

  const handleUnlockLocation = () => {
    if (!value) return;
    onChangeLocation({
      ...value,
      confirmed: false,
    });
  };

  if (!configLoaded) {
    return (
      <div className="p-4 rounded-xl border border-[#DCE0D8] bg-[#FAF9F6] flex items-center gap-2.5 text-xs text-[#5A6A60]">
        <Loader2 className="w-4 h-4 animate-spin text-[#1B4332]" />
        Loading interactive Google Maps pickup selector...
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div className="p-4 rounded-xl border border-[#EBC6BA] bg-[#FDF2EC] text-xs text-[#9E2F2F] space-y-1.5">
        <p className="font-semibold">Google Maps API Key Not Available</p>
        <p>
          To select an exact pickup pin and search genuine nearby charities via Google Places,
          ensure <code className="font-mono">GOOGLE_MAPS_API_KEY</code> is set in AI Studio
          Secrets and restart the app server.
        </p>
      </div>
    );
  }

  const isConfirmed = Boolean(value?.confirmed);

  return (
    <APIProvider apiKey={apiKey}>
      <div className="space-y-4">
        {/* Step 1: Search / Use Current Location */}
        <div className="space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-[#1A2820]">
                Exact Pickup Location (Google Maps) *
              </p>
              <p className="text-[11px] text-[#5A6A60]">
                Search an address, use your current GPS location, or click/drag the map pin.
              </p>
            </div>
            <button
              type="button"
              disabled={isConfirmed || locating || geocoding}
              onClick={handleUseCurrentLocation}
              className="px-3 py-2 rounded-xl border border-[#C7DBC9] bg-[#EEF3EC] text-[#1B4332] text-xs font-medium hover:bg-[#DFEBDD] transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {locating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Crosshair className="w-3.5 h-3.5" />
              )}
              {locating ? 'Locating...' : 'Use My Current Location'}
            </button>
          </div>

          <AddressAutocompleteInput
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            disabled={isConfirmed}
            searching={geocoding}
            onPickSuggestion={({ lat, lng, address, placeId }) => {
              setMapError('');
              setMapCenter({ lat, lng });
              setDesiredZoom(16);
              onChangeLocation({
                address,
                latitude: lat,
                longitude: lng,
                placeId,
                confirmed: false,
              });
            }}
            onSubmitSearch={() => void handleGeocodeSearch()}
          />

          {mapError && (
            <div className="p-2.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-xs text-[#9E2F2F]">
              {mapError}
            </div>
          )}

          {/* Interactive Google Map */}
          <div className="relative w-full h-[300px] sm:h-[340px] rounded-xl overflow-hidden border border-[#DCE0D8]">
            <GoogleMap
              mapId="DEMO_MAP_ID"
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              defaultCenter={mapCenter}
              defaultZoom={desiredZoom}
              gestureHandling="greedy"
              streetViewControl={false}
              mapTypeControl={false}
              onClick={(ev) => {
                if (isConfirmed) return;
                const latLng = ev.detail?.latLng;
                if (latLng) {
                  void reverseGeocodeCoords(latLng.lat, latLng.lng);
                }
              }}
            >
              <MapCameraController target={mapCenter} zoom={desiredZoom} />

              {value && (
                <AdvancedMarker
                  position={{ lat: value.latitude, lng: value.longitude }}
                  draggable={!isConfirmed}
                  title="Food Pickup Location"
                  onDragEnd={(ev) => {
                    if (isConfirmed) return;
                    const lat = ev.latLng?.lat();
                    const lng = ev.latLng?.lng();
                    if (typeof lat === 'number' && typeof lng === 'number') {
                      void reverseGeocodeCoords(lat, lng);
                    }
                  }}
                >
                  <Pin
                    background="#1B4332"
                    borderColor="#143325"
                    glyphColor="#FFFFFF"
                    scale={1.15}
                  />
                </AdvancedMarker>
              )}

              {charities.map((org) => {
                const isSelected = selectedOrganisation?.placeId === org.placeId;
                return (
                  <React.Fragment key={org.placeId}>
                    <AdvancedMarker
                      position={{ lat: org.latitude, lng: org.longitude }}
                      title={org.name}
                      onClick={() => setActiveInfoPlaceId(org.placeId)}
                    >
                      <Pin
                        background={isSelected ? '#2D6A4F' : '#B56A1B'}
                        borderColor={isSelected ? '#1B4332' : '#7D460B'}
                        glyphColor="#FFFFFF"
                        scale={isSelected ? 1.15 : 0.95}
                      />
                    </AdvancedMarker>

                    {activeInfoPlaceId === org.placeId && (
                      <InfoWindow
                        position={{ lat: org.latitude, lng: org.longitude }}
                        onCloseClick={() => setActiveInfoPlaceId(null)}
                      >
                        <div className="max-w-[220px] p-1 space-y-1 text-[#1A2820]">
                          <p className="text-xs font-semibold">{org.name}</p>
                          <p className="text-[11px] text-[#5A6A60]">{org.address}</p>
                          <p className="text-[11px] font-medium text-[#1B4332]">
                            {formatDistance(org.distanceMeters)}
                          </p>
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => {
                                onSelectOrganisation(org);
                                setActiveInfoPlaceId(null);
                              }}
                              className="px-2.5 py-1 rounded-lg bg-[#1B4332] text-white text-[11px] font-medium cursor-pointer"
                            >
                              {isSelected ? 'Selected' : 'Select'}
                            </button>
                            {org.directionsUri && (
                              <a
                                href={org.directionsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-[#1B4332] underline font-medium"
                              >
                                Directions
                              </a>
                            )}
                          </div>
                        </div>
                      </InfoWindow>
                    )}
                  </React.Fragment>
                );
              })}
            </GoogleMap>

            {geocoding && (
              <div className="absolute top-3 left-3 z-20 px-3 py-1.5 rounded-xl bg-white/95 border border-[#DCE0D8] shadow-sm text-xs text-[#1A2820] flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1B4332]" />
                Fetching address...
              </div>
            )}
          </div>

          {/* Selected Pin Address & Confirmation Bar */}
          <div
            className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
              isConfirmed
                ? 'bg-[#EEF3EC] border-[#C7DBC9]'
                : 'bg-[#FAF9F6] border-[#DCE0D8]'
            }`}
          >
            <div className="space-y-0.5 min-w-0">
              {value ? (
                <>
                  <p className="text-xs font-semibold text-[#1A2820] flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-[#1B4332] shrink-0" />
                    <span>{isConfirmed ? 'Confirmed Pickup Address' : 'Selected Pin Address'}</span>
                  </p>
                  <p className="text-xs text-[#34443A] break-words">{value.address}</p>
                  <p className="text-[11px] font-mono text-[#6B7A70] tabular-nums">
                    Coordinates: {value.latitude.toFixed(6)}, {value.longitude.toFixed(6)}
                  </p>
                </>
              ) : (
                <p className="text-xs text-[#5A6A60]">
                  Click anywhere on the map or search an address above to drop your pickup pin.
                </p>
              )}
            </div>

            {value && (
              <div className="shrink-0 flex items-center gap-2">
                {isConfirmed ? (
                  <button
                    type="button"
                    onClick={handleUnlockLocation}
                    className="px-3.5 py-2 rounded-xl bg-white border border-[#C7DBC9] text-xs font-medium text-[#1B4332] hover:bg-[#FAF9F6] cursor-pointer whitespace-nowrap"
                  >
                    Change Location
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={geocoding}
                    onClick={handleConfirmLocation}
                    className="px-4 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Confirm Pickup Location
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Nearby Genuine Charity Organisations */}
        {isConfirmed && (
          <div className="space-y-3 pt-2 border-t border-[#ECEEE8]">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-[#1A2820] flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-[#1B4332]" />
                  Nearby Verified Charity Organisations (Google Places)
                </h3>
                <p className="text-[11px] text-[#5A6A60]">
                  Genuine NGOs, food banks, orphanages, and community kitchens near your pickup pin.
                </p>
              </div>
              <button
                type="button"
                disabled={searchingCharities}
                onClick={() => value && void fetchNearbyCharities(value.latitude, value.longitude)}
                className="px-3 py-1.5 rounded-xl border border-[#DCE0D8] bg-white text-xs font-medium text-[#34443A] hover:bg-[#F4F5F2] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 self-start sm:self-auto"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${searchingCharities ? 'animate-spin' : ''}`} />
                Refresh Nearby
              </button>
            </div>

            {searchingCharities ? (
              <div className="p-5 rounded-xl border border-[#DCE0D8] bg-[#FAF9F6] flex items-center justify-center gap-2 text-xs text-[#5A6A60]">
                <Loader2 className="w-4 h-4 animate-spin text-[#1B4332]" />
                Searching genuine nearby charity organisations around your pickup pin...
              </div>
            ) : charityError ? (
              <div className="p-3.5 rounded-xl border border-[#EBC6BA] bg-[#FDF2EC] text-xs text-[#9E2F2F] flex items-center justify-between gap-2">
                <span>{charityError}</span>
                <button
                  type="button"
                  onClick={() => value && void fetchNearbyCharities(value.latitude, value.longitude)}
                  className="px-3 py-1.5 rounded-lg bg-white border border-[#EBC6BA] font-medium cursor-pointer shrink-0"
                >
                  Retry
                </button>
              </div>
            ) : hasSearchedCharities && charities.length === 0 ? (
              <div className="p-4 rounded-xl border border-[#DCE0D8] bg-[#FAF9F6] text-xs text-[#5A6A60]">
                No nearby charity organisations were returned by Google Places within 15 km of this
                pin. You can still publish your donation listing or adjust your pickup location.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {charities.map((org) => {
                  const isSelected = selectedOrganisation?.placeId === org.placeId;
                  return (
                    <div
                      key={org.placeId}
                      className={`p-3.5 rounded-xl border transition-colors ${
                        isSelected
                          ? 'bg-[#EEF3EC] border-[#1B4332]'
                          : 'bg-white border-[#E5E7E2] hover:border-[#C7DBC9]'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-[#1A2820]">{org.name}</p>
                            {org.category && (
                              <span className="text-[11px] font-medium text-[#52796F] bg-[#F2F4EF] px-2 py-0.5 rounded-md">
                                {org.category}
                              </span>
                            )}
                            {typeof org.distanceMeters === 'number' && (
                              <span className="text-[11px] font-mono font-medium text-[#1B4332] tabular-nums">
                                {formatDistance(org.distanceMeters)}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#4F5E55]">{org.address}</p>
                          <p className="text-xs text-[#5A6A60]">
                            {org.phone ? (
                              <a
                                href={`tel:${org.phone.replace(/[^\d+]/g, '')}`}
                                className="inline-flex items-center gap-1 text-[#1B4332] font-medium hover:underline"
                              >
                                <Phone className="w-3 h-3" />
                                {org.phone}
                              </a>
                            ) : (
                              <span className="text-[#6B7A70]">Phone not listed on Google Maps</span>
                            )}
                          </p>
                        </div>

                        <div className="flex flex-wrap sm:flex-col items-center sm:items-end gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              if (isSelected) {
                                onSelectOrganisation(null);
                              } else {
                                onSelectOrganisation(org);
                                setMapCenter({ lat: org.latitude, lng: org.longitude });
                                setActiveInfoPlaceId(org.placeId);
                              }
                            }}
                            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors cursor-pointer whitespace-nowrap inline-flex items-center gap-1 ${
                              isSelected
                                ? 'bg-[#1B4332] text-white'
                                : 'bg-[#EEF3EC] text-[#1B4332] hover:bg-[#DFEBDD]'
                            }`}
                          >
                            {isSelected && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {isSelected ? 'Selected' : 'Select Organisation'}
                          </button>

                          <div className="flex items-center gap-2">
                            {org.directionsUri && (
                              <a
                                href={org.directionsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1 rounded-lg border border-[#DCE0D8] bg-white text-[11px] font-medium text-[#1A2820] hover:bg-[#FAF9F6] inline-flex items-center gap-1"
                              >
                                <Navigation className="w-3 h-3 text-[#1B4332]" />
                                Get Directions
                              </a>
                            )}
                            {org.googleMapsUri && (
                              <a
                                href={org.googleMapsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1 rounded-lg border border-[#DCE0D8] bg-white text-[11px] font-medium text-[#5A6A60] hover:text-[#1A2820] inline-flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Maps
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </APIProvider>
  );
}
