import React, { useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Edit3,
  ExternalLink,
  HeartHandshake,
  Lock,
  MapPin,
  Navigation,
  Phone,
  Plus,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import {
  DONATION_STATUSES,
  FOOD_CATEGORIES,
  FOOD_IMAGE_PRESETS,
  FOOD_UNITS,
  ORGANIZATION_TYPES,
  type DonationListing,
  type DonationRequest,
  type DonationStatus,
  type FoodCategory,
  type FoodItem,
  type FoodUnit,
  type OrganizationType,
  type SelectedCharityOrganisation,
} from '../types';
import type { CreateDonationInput } from '../services/firestoreService';
import {
  addDaysIsoDate,
  formatQuantity,
  formatShortDate,
  formatTimestamp,
  getRecommendedPresetImage,
  isItemExpired,
} from '../utils/foodUtils';
import {
  DonationPickupMapSelector,
  type PickupLocationValue,
} from './DonationPickupMapSelector';
import { FoodImage } from './FoodImage';

function validateDonorPhone(raw: string): { valid: boolean; cleaned: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, cleaned: '', error: 'Donor phone number is required for pickup coordination.' };
  }
  if (!/^\+?[0-9\s\-\(\)]{7,24}$/.test(trimmed)) {
    return {
      valid: false,
      cleaned: trimmed,
      error: 'Enter a valid phone number (digits, spaces, hyphens, or leading + country code).',
    };
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return {
      valid: false,
      cleaned: trimmed,
      error: 'Phone number must contain between 7 and 15 digits.',
    };
  }
  return { valid: true, cleaned: trimmed };
}

function formatDistanceLabel(meters?: number): string {
  if (typeof meters !== 'number' || Number.isNaN(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

function buildPickupDirectionsUrl(don: DonationListing): string | null {
  if (don.selectedOrganisation?.directionsUri) {
    return don.selectedOrganisation.directionsUri;
  }
  if (typeof don.pickupLatitude === 'number' && typeof don.pickupLongitude === 'number') {
    if (don.selectedOrganisation) {
      return `https://www.google.com/maps/dir/?api=1&origin=${don.selectedOrganisation.latitude},${don.selectedOrganisation.longitude}&destination=${don.pickupLatitude},${don.pickupLongitude}`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${don.pickupLatitude},${don.pickupLongitude}`;
  }
  if (don.pickupAddress || don.pickupLocation) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      don.pickupAddress || don.pickupLocation
    )}`;
  }
  return null;
}

interface CharityDashboardProps {
  donations: DonationListing[];
  requests: DonationRequest[];
  activeFoods: FoodItem[];
  userEmail: string;
  prefillFood?: FoodItem | null;
  onClearPrefill: () => void;
  onCreateDonation: (input: CreateDonationInput) => Promise<void>;
  onUpdateDonation: (
    donation: DonationListing,
    updates: Partial<DonationListing>
  ) => Promise<void>;
  onTransitionStatus: (
    donation: DonationListing,
    status: DonationStatus,
    partner?: string
  ) => Promise<void>;
  onCreateRequest: (
    donation: DonationListing,
    input: {
      requesterName: string;
      organizationType: OrganizationType;
      requestedQuantity: number;
      pickupWindow: string;
      message?: string;
    }
  ) => Promise<void>;
  onUpdateRequestStatus: (
    req: DonationRequest,
    donation: DonationListing | undefined,
    status: 'Approved' | 'Collected' | 'Declined'
  ) => Promise<void>;
}

export function CharityDashboard({
  donations,
  requests,
  activeFoods,
  userEmail,
  prefillFood,
  onClearPrefill,
  onCreateDonation,
  onUpdateDonation,
  onTransitionStatus,
  onCreateRequest,
  onUpdateRequestStatus,
}: CharityDashboardProps) {
  const [activeTab, setActiveTab] = useState<'listings' | 'requests' | 'history'>('listings');
  const [showCreateModal, setShowCreateModal] = useState(Boolean(prefillFood));
  const [editingDonation, setEditingDonation] = useState<DonationListing | null>(null);
  const [requestTarget, setRequestTarget] = useState<DonationListing | null>(null);

  // Create/Edit Form State
  const [selectedFoodId, setSelectedFoodId] = useState<string>(prefillFood?.id || 'standalone');
  const [foodName, setFoodName] = useState(prefillFood?.name || '');
  const [quantity, setQuantity] = useState(prefillFood ? String(prefillFood.quantity) : '1');
  const [unit, setUnit] = useState<FoodUnit>(prefillFood?.unit || 'pcs');
  const [category, setCategory] = useState<FoodCategory>(prefillFood?.category || 'Produce');
  const [expiryDate, setExpiryDate] = useState(prefillFood?.expiryDate || addDaysIsoDate(3));
  const [imageUrl, setImageUrl] = useState(
    prefillFood?.imageUrl || getRecommendedPresetImage('Produce', '')
  );
  const [pickupLocation, setPickupLocation] = useState('');
  const [pickupLocationValue, setPickupLocationValue] = useState<PickupLocationValue | null>(null);
  const [selectedOrganisation, setSelectedOrganisation] =
    useState<SelectedCharityOrganisation | null>(null);
  const [donorPhone, setDonorPhone] = useState('');
  const [contactInfo, setContactInfo] = useState(userEmail);
  const [notes, setNotes] = useState('');
  const [charityPartner, setCharityPartner] = useState('');
  const [safetyConfirmed, setSafetyConfirmed] = useState(false);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Partner Request Modal State
  const [reqOrgName, setReqOrgName] = useState('');
  const [reqOrgType, setReqOrgType] = useState<OrganizationType>('Community Pantry');
  const [reqQty, setReqQty] = useState('1');
  const [reqWindow, setReqWindow] = useState('Today 4:00 PM – 6:00 PM');
  const [reqMsg, setReqMsg] = useState('');

  useEffect(() => {
    if (prefillFood) {
      openNewModal(prefillFood);
    }
  }, [prefillFood]);

  const safeActiveFoods = activeFoods.filter((f) => !isItemExpired(f.expiryDate));
  const availableDonations = donations.filter((d) => d.status === 'Available');
  const pendingRequests = requests.filter((r) => r.status === 'Pending');
  const completedDonations = donations.filter(
    (d) => d.status === 'Donated' || d.status === 'Collected'
  );
  const activeListings = donations.filter(
    (d) => d.status !== 'Donated' && d.status !== 'Cancelled'
  );

  function openNewModal(source?: FoodItem | null) {
    setEditingDonation(null);
    setFormError('');
    if (source) {
      setSelectedFoodId(source.id);
      setFoodName(source.name);
      setQuantity(String(source.quantity));
      setUnit(source.unit);
      setCategory(source.category);
      setExpiryDate(source.expiryDate);
      setImageUrl(source.imageUrl);
    } else {
      setSelectedFoodId('standalone');
      setFoodName('');
      setQuantity('1');
      setUnit('pcs');
      setCategory('Produce');
      setExpiryDate(addDaysIsoDate(3));
      setImageUrl(FOOD_IMAGE_PRESETS[0].url);
    }
    setPickupLocation('');
    setPickupLocationValue(null);
    setSelectedOrganisation(null);
    setDonorPhone('');
    setContactInfo(userEmail);
    setNotes('');
    setCharityPartner('');
    setSafetyConfirmed(false);
    setShowCreateModal(true);
  }

  function openEditModal(don: DonationListing) {
    setEditingDonation(don);
    setFormError('');
    setSelectedFoodId(don.foodId);
    setFoodName(don.foodName);
    setQuantity(String(don.quantity));
    setUnit(don.unit);
    setCategory(don.category);
    setExpiryDate(don.expiryDate);
    setImageUrl(don.imageUrl);
    setPickupLocation(don.pickupAddress || don.pickupLocation);
    if (typeof don.pickupLatitude === 'number' && typeof don.pickupLongitude === 'number') {
      setPickupLocationValue({
        address: don.pickupAddress || don.pickupLocation,
        latitude: don.pickupLatitude,
        longitude: don.pickupLongitude,
        placeId: don.pickupPlaceId,
        confirmed: true,
      });
    } else {
      setPickupLocationValue(null);
    }
    setSelectedOrganisation(don.selectedOrganisation || null);
    setDonorPhone(don.donorPhone || '');
    setContactInfo(don.contactInfo);
    setNotes(don.notes);
    setCharityPartner(don.charityPartner);
    setSafetyConfirmed(don.safetyConfirmed);
    setShowCreateModal(true);
  }

  function handleSelectInventorySource(id: string) {
    setSelectedFoodId(id);
    const match = safeActiveFoods.find((f) => f.id === id);
    if (match) {
      setFoodName(match.name);
      setQuantity(String(match.quantity));
      setUnit(match.unit);
      setCategory(match.category);
      setExpiryDate(match.expiryDate);
      setImageUrl(match.imageUrl);
    }
  }

  async function handleSaveDonation(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    if (!foodName.trim()) {
      setFormError('Please enter the surplus food name.');
      return;
    }
    if (Number(quantity) <= 0 || Number.isNaN(Number(quantity))) {
      setFormError('Available quantity must be greater than zero.');
      return;
    }
    if (isItemExpired(expiryDate)) {
      setFormError(
        'Food safety policy: Expired food cannot be listed for donation. Only fresh, safe food is eligible.'
      );
      return;
    }

    const effectivePickupAddress = (
      pickupLocationValue?.address || pickupLocation
    ).trim();

    if (!editingDonation && !pickupLocationValue?.confirmed) {
      setFormError(
        'Please select your exact pickup location on the Google Map and click "Confirm Pickup Location" before publishing.'
      );
      return;
    }
    if (editingDonation && pickupLocationValue && !pickupLocationValue.confirmed) {
      setFormError(
        'Please click "Confirm Pickup Location" after adjusting the map pin.'
      );
      return;
    }
    if (!effectivePickupAddress || effectivePickupAddress.length < 2) {
      setFormError('Please confirm a valid pickup location.');
      return;
    }

    const phoneValidation = validateDonorPhone(donorPhone);
    if (!phoneValidation.valid) {
      setFormError(phoneValidation.error || 'Please enter a valid donor contact phone number.');
      return;
    }

    const finalContactInfo = (contactInfo.trim() || userEmail || phoneValidation.cleaned).trim();
    if (finalContactInfo.length < 3) {
      setFormError('Please enter contact details for pickup coordination.');
      return;
    }
    if (!safetyConfirmed) {
      setFormError(
        'Please confirm that the food is unspoiled, hygienically stored, and safe for donation.'
      );
      return;
    }

    const finalPartnerName = (
      selectedOrganisation?.name ||
      charityPartner ||
      ''
    ).trim();

    setSaving(true);
    try {
      if (editingDonation) {
        await onUpdateDonation(editingDonation, {
          foodName: foodName.trim(),
          quantity: Number(quantity),
          unit,
          category,
          expiryDate,
          imageUrl,
          pickupLocation: effectivePickupAddress,
          pickupAddress: effectivePickupAddress,
          ...(pickupLocationValue
            ? {
                pickupLatitude: pickupLocationValue.latitude,
                pickupLongitude: pickupLocationValue.longitude,
                pickupPlaceId: pickupLocationValue.placeId,
              }
            : {}),
          donorPhone: phoneValidation.cleaned,
          contactInfo: finalContactInfo,
          notes: notes.trim(),
          charityPartner: finalPartnerName,
          ...(selectedOrganisation ? { selectedOrganisation } : {}),
        });
      } else {
        const srcFood = safeActiveFoods.find((f) => f.id === selectedFoodId) || null;
        await onCreateDonation({
          foodId: selectedFoodId,
          foodName: foodName.trim(),
          quantity: Number(quantity),
          unit,
          category,
          expiryDate,
          imageUrl,
          pickupLocation: effectivePickupAddress,
          pickupAddress: effectivePickupAddress,
          pickupLatitude: pickupLocationValue!.latitude,
          pickupLongitude: pickupLocationValue!.longitude,
          pickupPlaceId: pickupLocationValue!.placeId,
          donorPhone: phoneValidation.cleaned,
          contactInfo: finalContactInfo,
          notes: notes.trim(),
          charityPartner: finalPartnerName,
          selectedOrganisation: selectedOrganisation || undefined,
          safetyConfirmed: true,
          sourceFoodItem: srcFood,
        });
      }
      setShowCreateModal(false);
      onClearPrefill();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save donation listing.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitPartnerRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!requestTarget) return;
    if (!reqOrgName.trim() || !reqWindow.trim()) return;
    setSaving(true);
    try {
      await onCreateRequest(requestTarget, {
        requesterName: reqOrgName.trim(),
        organizationType: reqOrgType,
        requestedQuantity: Math.max(0.01, Number(reqQty) || 1),
        pickupWindow: reqWindow.trim(),
        message: reqMsg.trim(),
      });
      setRequestTarget(null);
      setReqOrgName('');
      setReqMsg('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-[#1A2820]">
            Charity & Food Donation Dashboard
          </h1>
          <p className="text-sm text-[#5A6A60]">
            Share safe, non-expired surplus food with verified local pantries, shelters, and NGOs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => openNewModal(null)}
          className="px-4 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          Create Donation Listing
        </button>
      </div>

      {/* Overview KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1.5">Total Food Donated</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#1B4332]">
            {completedDonations.length}
          </p>
          <p className="text-xs text-[#6B7A70] mt-1">Completed handoffs</p>
        </div>
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1.5">Available Donations</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#1A2820]">
            {availableDonations.length}
          </p>
          <p className="text-xs text-[#6B7A70] mt-1">Ready for pickup</p>
        </div>
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1.5">Pending Requests</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#B56A1B]">
            {pendingRequests.length}
          </p>
          <p className="text-xs text-[#6B7A70] mt-1">Awaiting approval</p>
        </div>
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1.5">Total Listings</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#355E4B]">
            {donations.length}
          </p>
          <p className="text-xs text-[#6B7A70] mt-1">All-time shared items</p>
        </div>
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center gap-1 p-1 bg-[#EFEFE9] rounded-xl w-full sm:w-fit overflow-x-auto no-scrollbar">
        <button
          type="button"
          onClick={() => setActiveTab('listings')}
          className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'listings' ? 'bg-white text-[#1A2820] shadow-xs' : 'text-[#5A6A60]'
          }`}
        >
          Active Listings ({activeListings.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('requests')}
          className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'requests' ? 'bg-white text-[#1A2820] shadow-xs' : 'text-[#5A6A60]'
          }`}
        >
          Donation Requests ({requests.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'history' ? 'bg-white text-[#1A2820] shadow-xs' : 'text-[#5A6A60]'
          }`}
        >
          Completed & Past ({donations.length - activeListings.length})
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'listings' && (
        <div className="space-y-4">
          {activeListings.length === 0 ? (
            <div className="bg-white border border-[#E5E7E2] rounded-2xl p-10 text-center">
              <HeartHandshake className="w-8 h-8 text-[#52796F] mx-auto mb-3" />
              <p className="text-base font-medium text-[#1A2820] mb-1">
                No active surplus listings yet
              </p>
              <p className="text-sm text-[#5A6A60] mb-5 max-w-md mx-auto">
                Share unopened or safe surplus food before expiry so local community pantries can
                put it to good use.
              </p>
              <button
                type="button"
                onClick={() => openNewModal(null)}
                className="px-4 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] cursor-pointer"
              >
                List Surplus Food
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {activeListings.map((don) => {
                const directionsHref = buildPickupDirectionsUrl(don);
                const selectedOrg = don.selectedOrganisation;
                const telNumber = (don.donorPhone || '').replace(/[^\d+]/g, '');

                return (
                  <div
                    key={don.id}
                    className="bg-white border border-[#E5E7E2] rounded-2xl overflow-hidden flex flex-col"
                  >
                    <div className="aspect-[16/9] bg-[#F2F4EF]">
                      <FoodImage src={don.imageUrl} alt={don.foodName} />
                    </div>
                    <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                      <div className="space-y-3">
                        <div>
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <h3 className="font-display text-base font-semibold text-[#1A2820]">
                              {don.foodName}
                            </h3>
                            <span className="font-mono text-xs font-semibold tabular-nums text-[#1B4332]">
                              {formatQuantity(don.quantity, don.unit)}
                            </span>
                          </div>
                          <p className="text-xs text-[#5A6A60]">
                            {don.category} · Best before {formatShortDate(don.expiryDate)} · Status:{' '}
                            <strong className="text-[#1A2820]">{don.status}</strong>
                          </p>
                        </div>

                        {/* Exact Pickup Address & Coordinates */}
                        <div className="p-3 rounded-xl bg-[#FAF9F6] border border-[#ECEEE8] space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[11px] font-semibold text-[#34443A] flex items-center gap-1">
                                <MapPin className="w-3.5 h-3.5 text-[#1B4332] shrink-0" />
                                Pickup Address
                              </p>
                              <p className="text-xs text-[#1A2820] mt-0.5 break-words">
                                {don.pickupAddress || don.pickupLocation}
                              </p>
                              {typeof don.pickupLatitude === 'number' &&
                                typeof don.pickupLongitude === 'number' && (
                                  <p className="text-[10px] font-mono text-[#6B7A70] tabular-nums mt-0.5">
                                    Pin: {don.pickupLatitude.toFixed(5)},{' '}
                                    {don.pickupLongitude.toFixed(5)}
                                  </p>
                                )}
                            </div>
                            {directionsHref && (
                              <a
                                href={directionsHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1.5 rounded-lg bg-white border border-[#DCE0D8] text-[11px] font-medium text-[#1B4332] hover:bg-[#EEF3EC] inline-flex items-center gap-1 shrink-0"
                              >
                                <Navigation className="w-3 h-3" />
                                Get Directions
                              </a>
                            )}
                          </div>
                        </div>

                        {/* Selected Charity Organisation & Private Donor Handoff Card */}
                        {(selectedOrg || don.charityPartner || don.donorPhone) && (
                          <div className="p-3 rounded-xl bg-[#EEF3EC]/70 border border-[#C7DBC9] space-y-2">
                            {(selectedOrg || don.charityPartner) && (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-[11px] font-semibold text-[#1B4332] flex items-center gap-1">
                                    <Building2 className="w-3.5 h-3.5 shrink-0" />
                                    Selected Charity Organisation
                                  </p>
                                  {selectedOrg?.distanceMeters !== undefined && (
                                    <span className="text-[11px] font-mono text-[#1B4332] tabular-nums">
                                      {formatDistanceLabel(selectedOrg.distanceMeters)}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs font-semibold text-[#1A2820]">
                                  {selectedOrg?.name || don.charityPartner}
                                  {selectedOrg?.category ? (
                                    <span className="font-normal text-[#5A6A60]">
                                      {' '}
                                      · {selectedOrg.category}
                                    </span>
                                  ) : null}
                                </p>
                                {selectedOrg?.address && (
                                  <p className="text-[11px] text-[#4F5E55]">{selectedOrg.address}</p>
                                )}
                                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                  {selectedOrg?.phone && (
                                    <a
                                      href={`tel:${selectedOrg.phone.replace(/[^\d+]/g, '')}`}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-[#C7DBC9] text-[11px] font-medium text-[#1B4332] hover:bg-[#FAF9F6]"
                                    >
                                      <Phone className="w-3 h-3" />
                                      Call Charity ({selectedOrg.phone})
                                    </a>
                                  )}
                                  {selectedOrg?.googleMapsUri && (
                                    <a
                                      href={selectedOrg.googleMapsUri}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-[#C7DBC9] text-[11px] font-medium text-[#34443A] hover:bg-[#FAF9F6]"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                      Google Maps
                                    </a>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Private Donor Contact for Selected Charity Pickup */}
                            {don.donorPhone && (
                              <div className="pt-2 border-t border-[#C7DBC9]/70 flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-[10px] font-medium text-[#355E4B] flex items-center gap-1">
                                    <Lock className="w-3 h-3 shrink-0" />
                                    Donor Contact (Shared only with selected organisation)
                                  </p>
                                  <p className="text-xs font-mono font-medium text-[#1A2820]">
                                    {don.donorPhone}
                                  </p>
                                </div>
                                {telNumber && (
                                  <a
                                    href={`tel:${telNumber}`}
                                    className="px-3 py-1.5 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] inline-flex items-center gap-1.5 shrink-0"
                                  >
                                    <Phone className="w-3.5 h-3.5" />
                                    Call Donor
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {!don.donorPhone && don.contactInfo && (
                          <p className="text-xs text-[#4F5E55]">Contact: {don.contactInfo}</p>
                        )}

                        {don.notes && (
                          <p className="text-xs text-[#5A6A60]">{don.notes}</p>
                        )}
                      </div>

                      <div className="space-y-2 pt-3 border-t border-[#ECEEE8]">
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label={`Change status for ${don.foodName}`}
                            value={don.status}
                            onChange={(e) =>
                              void onTransitionStatus(don, e.target.value as DonationStatus)
                            }
                            className="px-3 py-1.5 rounded-xl bg-[#FAF9F6] border border-[#DCE0D8] text-xs font-medium text-[#1A2820]"
                          >
                            {DONATION_STATUSES.map((st) => (
                              <option key={st} value={st}>
                                Status: {st}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              setRequestTarget(don);
                              setReqQty(String(don.quantity));
                              if (don.selectedOrganisation?.name) {
                                setReqOrgName(don.selectedOrganisation.name);
                              }
                            }}
                            className="px-3 py-1.5 rounded-xl bg-[#EEF3EC] text-[#1B4332] text-xs font-medium hover:bg-[#DFEBDD] transition-colors inline-flex items-center gap-1 cursor-pointer"
                          >
                            <UserPlus className="w-3.5 h-3.5" />
                            Log Partner Request
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditModal(don)}
                            className="p-1.5 rounded-xl border border-[#DCE0D8] text-[#34443A] hover:bg-[#F4F5F2] cursor-pointer"
                            title="Edit listing"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
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

      {activeTab === 'requests' && (
        <div className="bg-white border border-[#E5E7E2] rounded-2xl divide-y divide-[#ECEEE8]">
          {requests.length === 0 ? (
            <div className="p-10 text-center text-sm text-[#5A6A60]">
              No charity or NGO pickup requests recorded yet. Use “Log Partner Request” on any active
              listing to coordinate a pickup.
            </div>
          ) : (
            requests.map((reqItem) => {
              const linkedDon = donations.find((d) => d.id === reqItem.donationId);
              const isTerminal = reqItem.status === 'Collected' || reqItem.status === 'Declined';

              return (
                <div
                  key={reqItem.id}
                  className="p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-sm text-[#1A2820]">
                        {reqItem.requesterName}
                      </h3>
                      <span className="text-xs text-[#5A6A60]">· {reqItem.organizationType}</span>
                      <span className="text-xs font-medium text-[#1B4332]">· {reqItem.status}</span>
                    </div>
                    <p className="text-xs text-[#4F5E55]">
                      Requested{' '}
                      <strong className="font-mono tabular-nums">
                        {formatQuantity(reqItem.requestedQuantity, reqItem.unit)}
                      </strong>{' '}
                      of {reqItem.foodName} · Pickup window: {reqItem.pickupWindow}
                    </p>
                    {reqItem.message && (
                      <p className="text-xs text-[#5A6A60] mt-1">{reqItem.message}</p>
                    )}
                  </div>

                  {!isTerminal && (
                    <div className="flex items-center gap-2 shrink-0">
                      {reqItem.status === 'Pending' && (
                        <button
                          type="button"
                          onClick={() =>
                            void onUpdateRequestStatus(reqItem, linkedDon, 'Approved')
                          }
                          className="px-3 py-1.5 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] cursor-pointer"
                        >
                          Approve
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onUpdateRequestStatus(reqItem, linkedDon, 'Collected')}
                        className="px-3 py-1.5 rounded-xl bg-[#EEF3EC] text-[#1B4332] text-xs font-medium hover:bg-[#DFEBDD] cursor-pointer"
                      >
                        Mark Collected
                      </button>
                      <button
                        type="button"
                        onClick={() => void onUpdateRequestStatus(reqItem, linkedDon, 'Declined')}
                        className="px-3 py-1.5 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#9E2F2F] hover:bg-[#FDF2EC] cursor-pointer"
                      >
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="bg-white border border-[#E5E7E2] rounded-2xl divide-y divide-[#ECEEE8]">
          {donations.filter((d) => d.status === 'Donated' || d.status === 'Cancelled').length === 0 ? (
            <div className="p-10 text-center text-sm text-[#5A6A60]">
              Completed and cancelled donations will appear here.
            </div>
          ) : (
            donations
              .filter((d) => d.status === 'Donated' || d.status === 'Cancelled')
              .map((don) => (
                <div
                  key={don.id}
                  className="p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 rounded-xl overflow-hidden border border-[#E5E7E2] shrink-0">
                      <FoodImage src={don.imageUrl} alt={don.foodName} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#1A2820]">
                        {don.foodName} ·{' '}
                        <span className="font-mono tabular-nums">
                          {formatQuantity(don.quantity, don.unit)}
                        </span>
                      </p>
                      <p className="text-xs text-[#5A6A60]">
                        {don.pickupLocation}
                        {don.charityPartner ? ` · Shared with ${don.charityPartner}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-xs font-semibold ${
                        don.status === 'Donated' ? 'text-[#1B4332]' : 'text-[#6B7A70]'
                      }`}
                    >
                      {don.status}
                    </p>
                    <p className="text-[11px] text-[#6B7A70]">{formatTimestamp(don.updatedAt)}</p>
                  </div>
                </div>
              ))
          )}
        </div>
      )}

      {/* Create / Edit Donation Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1A2820]/40 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto">
          <div className="w-full max-w-3xl bg-white border border-[#E5E7E2] rounded-2xl p-4 sm:p-6 shadow-xl my-auto max-h-[92dvh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 mb-5 border-b border-[#E5E7E2]">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#1A2820]">
                  {editingDonation ? 'Edit Donation Listing' : 'Create Surplus Donation Listing'}
                </h2>
                <p className="text-xs text-[#5A6A60]">
                  Set your exact pickup pin on Google Maps, verify your phone number, and select a
                  nearby charity organisation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCreateModal(false);
                  onClearPrefill();
                }}
                className="p-2 rounded-xl text-[#5A6A60] hover:bg-[#F2F4EF] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveDonation} className="space-y-5">
              {formError && (
                <div className="p-3 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-sm text-[#9E2F2F]">
                  {formError}
                </div>
              )}

              {!editingDonation && safeActiveFoods.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1.5">
                    Select from Your Fresh Inventory (optional)
                  </label>
                  <select
                    value={selectedFoodId}
                    onChange={(e) => handleSelectInventorySource(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF9F6] border border-[#DCE0D8] text-sm text-[#1A2820]"
                  >
                    <option value="standalone">Enter a new surplus item manually</option>
                    {safeActiveFoods.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({formatQuantity(f.quantity, f.unit)} · expires {f.expiryDate})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Step 1: Food Details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Food Name *
                  </label>
                  <input
                    type="text"
                    value={foodName}
                    onChange={(e) => setFoodName(e.target.value)}
                    placeholder="e.g., Unopened Canned Beans, Fresh Apples"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Available Quantity *
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono tabular-nums"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">Unit *</label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as FoodUnit)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm"
                  >
                    {FOOD_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Food Category *
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as FoodCategory)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm"
                  >
                    {FOOD_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Expiry Date *
                  </label>
                  <input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono tabular-nums"
                  />
                </div>
              </div>

              {/* Step 2 & 4: Interactive Google Map Pickup Selector & Nearby Charities */}
              <div className="p-4 rounded-2xl bg-[#FAF9F6] border border-[#E5E7E2] space-y-3">
                <DonationPickupMapSelector
                  value={pickupLocationValue}
                  selectedOrganisation={selectedOrganisation}
                  onChangeLocation={(nextLoc) => {
                    setPickupLocationValue(nextLoc);
                    setPickupLocation(nextLoc.address);
                  }}
                  onSelectOrganisation={(org) => {
                    setSelectedOrganisation(org);
                    if (org) {
                      setCharityPartner(org.name);
                    }
                  }}
                />

                {selectedOrganisation && (
                  <div className="p-3 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] flex items-center justify-between gap-2 text-xs text-[#1B4332]">
                    <span>
                      Selected organisation: <strong>{selectedOrganisation.name}</strong> (
                      {selectedOrganisation.address})
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedOrganisation(null);
                        setCharityPartner('');
                      }}
                      className="underline font-medium cursor-pointer shrink-0"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Step 3: Mandatory Donor Contact Phone & Additional Notes */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Donor Contact Phone Number *
                  </label>
                  <input
                    type="tel"
                    required
                    value={donorPhone}
                    onChange={(e) => setDonorPhone(e.target.value)}
                    placeholder="e.g., +91 98765 43210"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono"
                  />
                  <p className="text-[11px] text-[#6B7A70] mt-1 flex items-center gap-1">
                    <Lock className="w-3 h-3 shrink-0" />
                    Private: shared only with the selected charity organisation for pickup.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Pickup Coordination Email / Backup Note *
                  </label>
                  <input
                    type="text"
                    value={contactInfo}
                    onChange={(e) => setContactInfo(e.target.value)}
                    placeholder="Email or alternate pickup note"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Additional Notes (allergens, gate code, pickup hours)
                  </label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g., Sealed factory packaging, pickup before 7 PM"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2.5 p-3.5 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] text-xs text-[#1B4332] cursor-pointer">
                <input
                  type="checkbox"
                  checked={safetyConfirmed}
                  onChange={(e) => setSafetyConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-[#52796F] text-[#1B4332]"
                />
                <span>
                  <strong className="inline-flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" /> Food Safety Confirmation:
                  </strong>{' '}
                  I confirm this food is NOT expired, has been stored safely, and is hygienic for
                  community donation.
                </span>
              </label>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    onClearPrefill();
                  }}
                  className="px-4 py-2.5 rounded-xl border border-[#DCE0D8] text-sm font-medium text-[#34443A]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Publishing...' : editingDonation ? 'Save Changes' : 'Publish Donation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Log Charity Partner Pickup Request Modal */}
      {requestTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1A2820]/40 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-md bg-white border border-[#E5E7E2] rounded-2xl p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-[#E5E7E2]">
              <h3 className="font-display text-base font-semibold text-[#1A2820]">
                Log Request for {requestTarget.foodName}
              </h3>
              <button
                type="button"
                onClick={() => setRequestTarget(null)}
                className="p-1.5 rounded-lg text-[#5A6A60] hover:bg-[#F2F4EF]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmitPartnerRequest} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-[#34443A] mb-1">
                  Charity / Organization Name *
                </label>
                <input
                  type="text"
                  required
                  value={reqOrgName}
                  onChange={(e) => setReqOrgName(e.target.value)}
                  placeholder="e.g., Green Valley Community Pantry"
                  className="w-full px-3.5 py-2 rounded-xl border border-[#DCE0D8] text-sm"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Partner Type
                  </label>
                  <select
                    value={reqOrgType}
                    onChange={(e) => setReqOrgType(e.target.value as OrganizationType)}
                    className="w-full px-3 py-2 rounded-xl border border-[#DCE0D8] text-sm"
                  >
                    {ORGANIZATION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1">
                    Quantity ({requestTarget.unit})
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    max={requestTarget.quantity}
                    value={reqQty}
                    onChange={(e) => setReqQty(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-[#DCE0D8] text-sm font-mono tabular-nums"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#34443A] mb-1">
                  Pickup Window *
                </label>
                <input
                  type="text"
                  required
                  value={reqWindow}
                  onChange={(e) => setReqWindow(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-[#DCE0D8] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#34443A] mb-1">
                  Message (optional)
                </label>
                <input
                  type="text"
                  value={reqMsg}
                  onChange={(e) => setReqMsg(e.target.value)}
                  placeholder="Volunteer pickup notes"
                  className="w-full px-3.5 py-2 rounded-xl border border-[#DCE0D8] text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setRequestTarget(null)}
                  className="px-4 py-2 rounded-xl border border-[#DCE0D8] text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Save Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
